import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const input = z.object({
  investigationId: z.string().uuid(),
  /** Storage path of the extracted UTF-8 plain-text specimen. */
  textPath: z.string().min(1),
  fileName: z.string().min(1),
  declaredMime: z.string().default("text/plain"),
  /** Origin of the specimen: PLAIN TEXT / PDF EXTRACTION / DOCX EXTRACTION / PASTED. */
  extractedFrom: z.string().default("PLAIN TEXT"),
});

/**
 * Deterministic linguistic examination of text evidence. Runs entirely
 * server-side and persists the report into the existing analysis_results
 * JSONB columns — no schema change, no randomness, hash-cached like images.
 */
export const analyzeTextEvidence = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => input.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { sha256Hex } = await import("./forensics.server");
    const { analyzeText, TEXT_ENGINE_VERSION } = await import("./text-forensics.server");

    const download = await supabaseAdmin.storage.from("evidence").download(data.textPath);
    if (download.error || !download.data) {
      throw new Error(
        `The extracted text specimen could not be retrieved for analysis: ${download.error?.message ?? "unknown error"}`,
      );
    }
    const buffer = new Uint8Array(await download.data.arrayBuffer());
    const text = new TextDecoder().decode(buffer);
    if (!text.trim()) throw new Error("The stored text specimen is empty.");
    const hash = await sha256Hex(buffer);

    // Determinism cache: identical specimen bytes always return the stored result.
    const cachedRow = await supabaseAdmin
      .from("analysis_results")
      .select("*")
      .eq("file_hash", hash)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const cachedSignals = cachedRow.data?.signals as { engineVersion?: number; mediaKind?: string } | null | undefined;
    const usable =
      cachedSignals && cachedSignals.mediaKind === "text" && cachedSignals.engineVersion === TEXT_ENGINE_VERSION
        ? cachedRow.data
        : null;

    const report = usable
      ? (usable.signals as unknown as ReturnType<typeof analyzeText>)
      : analyzeText(text, hash, {
          fileName: data.fileName,
          declaredMime: data.declaredMime,
          byteSize: buffer.byteLength,
          extractedFrom: data.extractedFrom,
        });

    const insert = await supabaseAdmin.from("analysis_results").insert({
      investigation_id: data.investigationId,
      file_hash: hash,
      ai_probability: report.aiProbability,
      manipulation_probability: report.manipulationProbability,
      authenticity_confidence: report.authenticityConfidence,
      risk_level: report.riskLevel,
      findings: report.findings as never,
      signals: report as never,
    });
    if (insert.error) throw new Error(`Analysis results could not be saved: ${insert.error.message}`);

    const upd = await supabaseAdmin
      .from("investigations")
      .update({
        status: "complete",
        ai_probability: report.aiProbability,
        manipulation_probability: report.manipulationProbability,
        authenticity_confidence: report.authenticityConfidence,
        risk_level: report.riskLevel,
        metadata_status: report.metadataStatus,
        source_trace_status: "NOT_AVAILABLE",
        summary: report.summary,
      })
      .eq("id", data.investigationId);
    if (upd.error) throw new Error(`Investigation record could not be updated: ${upd.error.message}`);

    return { ok: true as const, fileHash: hash, cached: Boolean(usable) };
  });
