import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const frameSchema = z.object({
  index: z.number().int().min(0),
  timestamp: z.number().min(0),
  pngBase64: z.string().min(32),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const input = z.object({
  investigationId: z.string().uuid(),
  storagePath: z.string().min(1),
  fileName: z.string().min(1),
  fileType: z.string().default("video/mp4"),
  container: z.object({
    durationSeconds: z.number().min(0),
    analysedSeconds: z.number().min(0),
    width: z.number().int().min(0),
    height: z.number().int().min(0),
    truncated: z.boolean(),
  }),
  frames: z.array(frameSchema).min(2).max(12),
});

export const VIDEO_ENGINE_VERSION = 1;

/** Pixel-family scoring keys of the shared image engine (metadata keys excluded). */
const PIXEL_KEYS = [
  "lowNoiseFloor",
  "uniformNoiseTexture",
  "edgeEnergyUniformity",
  "lowColorEntropy",
  "periodicPattern",
  "uniformLuminance",
];

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function stats(values: number[]): { mean: number; sd: number; cv: number } {
  if (!values.length) return { mean: 0, sd: 0, cv: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return { mean, sd, cv: mean === 0 ? 0 : sd / mean };
}
const r2 = (v: number) => Math.round(v * 100) / 100;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
function band(score: number): string {
  if (score <= 20) return "Low";
  if (score <= 40) return "Mild";
  if (score <= 60) return "Moderate";
  if (score <= 80) return "High";
  return "Very High";
}

/**
 * Deterministic video examination: the caller supplies a fixed, evenly spaced
 * set of decoded frames; each frame is run through the SAME image forensic
 * engine used for image evidence (analyzeBytes — not a fork of it), then the
 * per-frame results are combined with a cross-frame consistency measurement.
 */
export const analyzeVideoEvidence = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => input.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { analyzeBytes, sha256Hex } = await import("./forensics.server");

    const download = await supabaseAdmin.storage.from("evidence").download(data.storagePath);
    if (download.error || !download.data) {
      throw new Error(`Evidence file could not be retrieved for analysis: ${download.error?.message ?? "unknown error"}`);
    }
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    const hash = await sha256Hex(bytes);

    const cachedRow = await supabaseAdmin
      .from("analysis_results")
      .select("*")
      .eq("file_hash", hash)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const cachedSignals = cachedRow.data?.signals as { engineVersion?: number; mediaKind?: string } | null | undefined;
    const cached =
      cachedSignals && cachedSignals.mediaKind === "video" && cachedSignals.engineVersion === VIDEO_ENGINE_VERSION
        ? cachedRow.data
        : null;

    let report: Record<string, unknown>;

    if (cached) {
      report = cached.signals as Record<string, unknown>;
    } else {
      const frames = [...data.frames].sort((a, b) => a.index - b.index);
      const perFrame: {
        index: number;
        timestamp: number;
        aiScore: number;
        noiseFloor: number | null;
        edgeEnergy: number | null;
        colorEntropy: number | null;
        noiseIrregularity: number | null;
        available: boolean;
        topSignal: string | null;
      }[] = [];

      for (const frame of frames) {
        const frameBytes = decodeBase64(frame.pngBase64);
        const local = await analyzeBytes(frameBytes, `frame-${frame.index}.png`);
        const pixel = local.signalBreakdown.filter((b) => PIXEL_KEYS.includes(b.signal));
        const maxPoints = pixel.reduce((a, b) => a + b.weight, 0) || 1;
        const earned = pixel.reduce((a, b) => a + b.contribution, 0);
        const strongest = [...pixel].sort((a, b) => b.contribution - a.contribution)[0];
        perFrame.push({
          index: frame.index,
          timestamp: frame.timestamp,
          aiScore: r2((earned / maxPoints) * 100),
          noiseFloor: local.imageStats.noiseFloor ?? null,
          edgeEnergy: local.imageStats.edgeEnergyMean ?? null,
          colorEntropy: local.imageStats.colorEntropy ?? null,
          noiseIrregularity: local.imageStats.noiseIrregularity ?? null,
          available: local.imageStats.available,
          topSignal: strongest && strongest.contribution > 0 ? strongest.signal : null,
        });
      }

      const usable = perFrame.filter((f) => f.available);
      if (usable.length < 2) {
        throw new Error(
          "Fewer than two sampled frames could be decoded for pixel analysis. The video may be unreadable at the sampled timestamps.",
        );
      }

      const frameScores = usable.map((f) => f.aiScore);
      const noise = stats(usable.map((f) => f.noiseFloor ?? 0));
      const edge = stats(usable.map((f) => f.edgeEnergy ?? 0));
      const entropy = stats(usable.map((f) => f.colorEntropy ?? 0));
      const scoreStats = stats(frameScores);

      // Cross-frame consistency: real camera footage varies frame to frame from
      // motion, lighting flicker and sensor noise. Unusually low variation of
      // noise and texture statistics is a weak, weighted synthetic indicator.
      const crossFrameCv = (noise.cv + edge.cv) / 2;
      const crossFrameNorm = clamp01((0.06 - crossFrameCv) / 0.055);

      // Outlier frames: robust deviation of per-frame noise floor. A single
      // frame far from the sequence baseline is a splice / re-encode indicator.
      const sorted = [...usable.map((f) => f.noiseFloor ?? 0)].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const mad =
        [...usable.map((f) => Math.abs((f.noiseFloor ?? 0) - median))].sort((a, b) => a - b)[
          Math.floor(usable.length / 2)
        ] ?? 0;
      const outliers = mad > 0 ? usable.filter((f) => Math.abs((f.noiseFloor ?? 0) - median) / mad > 3).length : 0;
      const outlierRatio = outliers / usable.length;

      const meanFrameScore = scoreStats.mean;
      const aiProbability = Math.max(
        0,
        Math.min(100, Math.round((meanFrameScore * 0.85 + crossFrameNorm * 100 * 0.15) * 10) / 10),
      );
      const manipulationProbability = Math.round(Math.min(100, outlierRatio * 100 * 0.4 + (entropy.cv > 0.12 ? 12 : 0)) * 10) / 10;

      const coverage = usable.length / frames.length;
      const agreement =
        Math.abs(usable.filter((f) => f.aiScore >= 50).length / usable.length - 0.5) * 2;
      const authenticityConfidence = Math.round(100 * clamp01(0.3 + 0.3 * coverage + 0.25 * agreement + 0.15 * clamp01(usable.length / 6)));

      const signals = [
        {
          key: "frameSampling",
          label: "Deterministic frame sampling",
          value: `${usable.length} of ${frames.length} frames decoded across ${r2(data.container.analysedSeconds)}s`,
          status: "supportive" as const,
          detail: `Frames are sampled at fixed fractions of the analysed window, so repeat examinations use identical timestamps.${data.container.truncated ? ` Only the first ${Math.round(data.container.analysedSeconds)} seconds were analysed.` : ""}`,
        },
        {
          key: "perFramePixelScore",
          label: "Mean per-frame pixel indicator score",
          value: `${r2(meanFrameScore)}% (spread ${r2(scoreStats.sd)} points)`,
          status: (meanFrameScore >= 50 ? "inconsistent" : "supportive") as "supportive" | "inconsistent",
          detail: "Each frame is scored by the same pixel-level engine used for image evidence (noise floor, edge energy, histogram entropy, periodicity).",
        },
        {
          key: "crossFrameConsistency",
          label: "Cross-frame statistical variation",
          value: `Noise CV ${r2(noise.cv)}, edge CV ${r2(edge.cv)}`,
          status: (crossFrameNorm >= 0.5 ? "inconsistent" : "supportive") as "supportive" | "inconsistent",
          detail: "Frame-to-frame variation of noise and texture statistics. Very low variation is a weak synthetic indicator.",
        },
        {
          key: "frameOutliers",
          label: "Outlier frames",
          value: outliers === 0 ? "None" : `${outliers} of ${usable.length} frames`,
          status: (outliers > 0 ? "inconsistent" : "supportive") as "supportive" | "inconsistent",
          detail: "Frames whose noise floor deviates more than three robust deviations from the sequence baseline.",
        },
        {
          key: "containerMetadata",
          label: "Container metadata",
          value: `${data.container.width}×${data.container.height}, ${r2(data.container.durationSeconds)}s, ${data.fileType}`,
          status: "supportive" as const,
          detail:
            "Container-level properties reported by the decoder. Missing encoder tags are reported neutrally and never treated as proof of anything.",
        },
      ];

      const signalBreakdown = [
        { signal: "perFramePixelIndicators", weight: 85, normalized: r2(meanFrameScore / 100), contribution: r2(meanFrameScore * 0.85), scope: "ai" as const },
        { signal: "crossFrameUniformity", weight: 15, normalized: r2(crossFrameNorm), contribution: r2(crossFrameNorm * 15), scope: "ai" as const },
        { signal: "frameNoiseOutliers", weight: 40, normalized: r2(outlierRatio), contribution: r2(outlierRatio * 40), scope: "manipulation" as const },
      ];

      const strongest = [...usable].sort((a, b) => b.aiScore - a.aiScore)[0]!;
      const findings = [
        {
          id: "video-frame-aggregate",
          title: `Highest-scoring frame at ${r2(strongest.timestamp)}s: ${strongest.aiScore}% pixel indicator score`,
          severity: (strongest.aiScore >= 70 ? "MODERATE" : "LOW") as "MODERATE" | "LOW" | "INFORMATIONAL" | "HIGH",
          confidence: Math.round(strongest.aiScore),
          signalType: "pixel",
          explanation: strongest.topSignal
            ? `Strongest contributing pixel signal on this frame: ${strongest.topSignal}.`
            : "No individual pixel signal fired strongly on this frame.",
        },
        {
          id: "video-cross-frame",
          title:
            crossFrameNorm >= 0.5
              ? `Unusually uniform frame-to-frame statistics (noise CV ${r2(noise.cv)})`
              : `Frame-to-frame variation within expected camera range (noise CV ${r2(noise.cv)})`,
          severity: (crossFrameNorm >= 0.5 ? "LOW" : "INFORMATIONAL") as "MODERATE" | "LOW" | "INFORMATIONAL" | "HIGH",
          confidence: Math.round(crossFrameNorm * 100),
          signalType: "temporal",
          explanation:
            "Computed from the per-frame noise floor and edge energy of the sampled frames only; it is a weak weighted signal, not a verdict.",
        },
      ];
      if (outliers > 0) {
        findings.push({
          id: "video-outliers",
          title: `${outliers} sampled frame(s) deviate strongly from the sequence noise baseline`,
          severity: "MODERATE",
          confidence: Math.round(outlierRatio * 100),
          signalType: "temporal",
          explanation: "Localised noise-floor discontinuities can indicate re-encoding or splicing of part of the timeline.",
        });
      }

      const riskLevel =
        aiProbability >= 80 || manipulationProbability >= 70
          ? "CRITICAL"
          : aiProbability >= 60 || manipulationProbability >= 45
            ? "HIGH"
            : aiProbability >= 35 || manipulationProbability >= 25
              ? "MODERATE"
              : "LOW";

      report = {
        engineVersion: VIDEO_ENGINE_VERSION,
        mediaKind: "video",
        fileHash: hash,
        file: {
          detectedFormat: "VIDEO",
          detectedMime: data.fileType,
          byteSize: bytes.byteLength,
          width: data.container.width || null,
          height: data.container.height || null,
          aspectRatio:
            data.container.width && data.container.height
              ? `${r2(data.container.width / data.container.height)}:1`
              : null,
        },
        exif: {
          duration_seconds: r2(data.container.durationSeconds),
          analysed_seconds: r2(data.container.analysedSeconds),
          resolution: `${data.container.width}×${data.container.height}`,
          declared_mime: data.fileType,
          sampled_frames: frames.length,
        },
        metadataStatus: "PARTIALLY_AVAILABLE",
        metadataStatusReason:
          "Container-level properties were read from the decoder. Codec-internal and encoder tags are not extractable in this prototype and are reported neutrally.",
        imageStats: {
          available: true,
          noiseFloor: r2(noise.mean),
          edgeEnergyMean: r2(edge.mean),
          colorEntropy: r2(entropy.mean),
          sampledPixels: usable.length,
          reason: "Aggregated across the sampled frames.",
        },
        jpeg: { isJpeg: false },
        c2paPresent: false,
        video: {
          container: data.container,
          frames: perFrame.map((f) => ({ ...f, aiScore: r2(f.aiScore), noiseFloor: f.noiseFloor === null ? null : r2(f.noiseFloor) })),
          crossFrame: {
            noiseCv: r2(noise.cv),
            edgeCv: r2(edge.cv),
            entropyCv: r2(entropy.cv),
            scoreSpread: r2(scoreStats.sd),
            uniformityNormalized: r2(crossFrameNorm),
            outlierFrames: outliers,
          },
        },
        signals,
        signalBreakdown,
        findings,
        aiProbability,
        manipulationProbability,
        authenticityConfidence,
        confidenceStatus: "SUFFICIENT",
        confidenceReason: `${usable.length} of ${frames.length} sampled frames were decodable for pixel analysis.`,
        riskLevel,
        aiBand: band(aiProbability),
        manipulationBand: band(manipulationProbability),
        summary: `${usable.length} deterministic frames sampled across ${r2(data.container.analysedSeconds)}s were examined with the image pixel engine. Mean per-frame indicator score ${r2(meanFrameScore)}%, cross-frame noise variation CV ${r2(noise.cv)}, ${outliers} outlier frame(s) — combined AI-generation likelihood ${aiProbability}% (${band(aiProbability)}).`,
        availableSignalCount: signals.length,
      };
    }

    const rep = report as unknown as {
      aiProbability: number;
      manipulationProbability: number;
      authenticityConfidence: number;
      riskLevel: string;
      findings: unknown;
      metadataStatus: string;
      summary: string;
    };

    const insert = await supabaseAdmin.from("analysis_results").insert({
      investigation_id: data.investigationId,
      file_hash: hash,
      ai_probability: rep.aiProbability,
      manipulation_probability: rep.manipulationProbability,
      authenticity_confidence: rep.authenticityConfidence,
      risk_level: rep.riskLevel,
      findings: rep.findings as never,
      signals: report as never,
    });
    if (insert.error) throw new Error(`Analysis results could not be saved: ${insert.error.message}`);

    const upd = await supabaseAdmin
      .from("investigations")
      .update({
        status: "complete",
        ai_probability: rep.aiProbability,
        manipulation_probability: rep.manipulationProbability,
        authenticity_confidence: rep.authenticityConfidence,
        risk_level: rep.riskLevel,
        metadata_status: rep.metadataStatus,
        source_trace_status: "NOT_AVAILABLE",
        summary: rep.summary,
      })
      .eq("id", data.investigationId);
    if (upd.error) throw new Error(`Investigation record could not be updated: ${upd.error.message}`);

    return { ok: true as const, fileHash: hash, cached: Boolean(cached) };
  });
