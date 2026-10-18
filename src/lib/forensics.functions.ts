import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const analyzeInput = z.object({
  investigationId: z.string().uuid(),
  storagePath: z.string().min(1),
  fileName: z.string().min(1),
  fileType: z.string().default(""),
});


/**
 * Runs the deterministic forensic engine server-side on the stored evidence
 * file and persists the result. Scoring logic never reaches the client.
 */
export const analyzeEvidence = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => analyzeInput.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { analyzeBytes, sha256Hex, ENGINE_VERSION } = await import("./forensics.server");
    const { detectAiGenerated, applyAiDetection } = await import("./sightengine.server");
    const { computeRegionalMap } = await import("./regional.server");

    const download = await supabaseAdmin.storage.from("evidence").download(data.storagePath);
    if (download.error || !download.data) {
      throw new Error(`Evidence file could not be retrieved for analysis: ${download.error?.message ?? "unknown error"}`);
    }
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    const hash = await sha256Hex(bytes);

    // Determinism / dedupe cache: identical bytes always return the stored
    // result, but only when it was produced by the current engine version.
    const cachedRow = await supabaseAdmin
      .from("analysis_results")
      .select("*")
      .eq("file_hash", hash)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const cachedSignals = cachedRow.data?.signals as
      | { engineVersion?: number; aiDetection?: unknown; regional?: unknown }
      | null
      | undefined;
    const cached =
      cachedSignals && cachedSignals.engineVersion === ENGINE_VERSION && cachedSignals.aiDetection && cachedSignals.regional
        ? cachedRow
        : { data: null as typeof cachedRow.data };

    let report: Record<string, unknown>;
    let ai: number;
    let manip: number;
    let conf: number;
    let risk: string;
    let findings: unknown;

    if (cached.data) {
      report = cached.data.signals as Record<string, unknown>;
      ai = Number(cached.data.ai_probability);
      manip = Number(cached.data.manipulation_probability);
      conf = Number(cached.data.authenticity_confidence);
      risk = String(cached.data.risk_level);
      findings = cached.data.findings;
    } else {
      const local = await analyzeBytes(bytes, data.fileName);
      // Real AI-generation detection. Throws on failure so that no score is
      // ever fabricated when the provider is unavailable or returns nothing.
      const detection = await detectAiGenerated(
        bytes,
        data.fileName,
        data.fileType || (local.file.detectedMime ?? "application/octet-stream"),
      );
      const computed = applyAiDetection(local, detection);
      // Regional forensic signal map — deterministic per-tile measurements from
      // the same bytes, persisted alongside the report so the heatmap page never
      // recomputes and can never disagree with the Results page.
      const regional = computeRegionalMap(
        local.file.detectedFormat,
        bytes,
        local.file.width ?? null,
        local.file.height ?? null,
      );
      report = { ...(computed as unknown as Record<string, unknown>), regional };
      ai = computed.aiProbability;
      manip = computed.manipulationProbability;
      conf = computed.authenticityConfidence;
      risk = computed.riskLevel;
      findings = computed.findings;
    }


    const insert = await supabaseAdmin.from("analysis_results").insert({
      investigation_id: data.investigationId,
      file_hash: hash,
      ai_probability: ai,
      manipulation_probability: manip,
      authenticity_confidence: conf,
      risk_level: risk,
      findings: findings as never,
      signals: report as never,
    });
    if (insert.error) throw new Error(`Analysis results could not be saved: ${insert.error.message}`);

    const r = report as unknown as {
      metadataStatus?: string;
      summary?: string;
      file?: { detectedMime?: string; width?: number; height?: number };
      fileHash?: string;
    };

    const upd = await supabaseAdmin
      .from("investigations")
      .update({
        status: "complete",
        ai_probability: ai,
        manipulation_probability: manip,
        authenticity_confidence: conf,
        risk_level: risk,
        metadata_status: r.metadataStatus ?? "UNKNOWN",
        source_trace_status: "NOT_AVAILABLE",
        summary: r.summary ?? null,
      })
      .eq("id", data.investigationId);
    if (upd.error) throw new Error(`Investigation record could not be updated: ${upd.error.message}`);

    return { ok: true as const, fileHash: hash, cached: Boolean(cached.data) };
  });
