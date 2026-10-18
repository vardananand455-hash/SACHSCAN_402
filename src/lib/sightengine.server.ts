/**
 * Sightengine AI-generated content detection (server-only).
 *
 * Images: POST https://api.sightengine.com/1.0/check.json          (models=genai)
 * Videos: POST https://api.sightengine.com/1.0/video/check-sync.json (models=genai)
 *
 * Credentials are read from server environment variables inside the call, and
 * never reach client code. If the API fails or returns no usable score, this
 * module throws — no score is ever fabricated.
 */

export interface GeneratorScore {
  name: string;
  score: number; // 0-1
}

export interface SightengineResult {
  /** 0-100 AI-generation confidence, derived from type.ai_generated. */
  aiProbability: number;
  /** Raw 0-1 value returned by the API. */
  rawScore: number;
  mediaKind: "image" | "video";
  /** Highest-scoring generator, when generator-specific scores are returned. */
  topGenerator: GeneratorScore | null;
  generators: GeneratorScore[];
}

const IMAGE_ENDPOINT = "https://api.sightengine.com/1.0/check.json";
const VIDEO_ENDPOINT = "https://api.sightengine.com/1.0/video/check-sync.json";

function readCredentials(): { apiUser: string; apiSecret: string } {
  const apiUser = process.env["SIGHTENGINE_API_USER"];
  const apiSecret = process.env["SIGHTENGINE_API_SECRET"];
  if (!apiUser || !apiSecret) {
    throw new Error(
      "AI-detection credentials are not configured on the server (SIGHTENGINE_API_USER / SIGHTENGINE_API_SECRET).",
    );
  }
  return { apiUser, apiSecret };
}

function collectGenerators(payload: unknown): GeneratorScore[] {
  const type = (payload as { type?: Record<string, unknown> } | null)?.type;
  if (!type || typeof type !== "object") return [];
  const out: GeneratorScore[] = [];
  const nested = (type as { ai_generators?: Record<string, unknown> }).ai_generators;
  const source = nested && typeof nested === "object" ? nested : type;
  for (const [key, value] of Object.entries(source)) {
    if (key === "ai_generated" || typeof value !== "number") continue;
    out.push({ name: key, score: value });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Calls Sightengine with the evidence bytes and returns the real detection result. */
export async function detectAiGenerated(
  bytes: Uint8Array,
  fileName: string,
  contentType: string,
): Promise<SightengineResult> {
  const { apiUser, apiSecret } = readCredentials();
  const mediaKind: "image" | "video" = contentType.startsWith("video/") ? "video" : "image";
  const endpoint = mediaKind === "video" ? VIDEO_ENDPOINT : IMAGE_ENDPOINT;

  const form = new FormData();
  form.append("models", "genai");
  form.append("api_user", apiUser);
  form.append("api_secret", apiSecret);
  form.append(
    "media",
    new Blob([bytes as unknown as BlobPart], { type: contentType || "application/octet-stream" }),
    fileName || "evidence",
  );

  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", body: form });
  } catch (e) {
    throw new Error(`The AI-detection service could not be reached: ${(e as Error).message}`);
  }

  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`The AI-detection service returned an unreadable response (HTTP ${response.status}).`);
  }

  if (!response.ok || payload["status"] === "failure") {
    const err = payload["error"] as { message?: string; code?: string | number } | undefined;
    throw new Error(
      `The AI-detection service rejected the request (HTTP ${response.status}${err?.code ? `, code ${err.code}` : ""}): ${
        err?.message ?? text.slice(0, 200)
      }`,
    );
  }

  const raw = (payload["type"] as { ai_generated?: unknown } | undefined)?.ai_generated;
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    throw new Error("The AI-detection service returned no AI-generation score for this file.");
  }

  const generators = collectGenerators(payload);
  return {
    aiProbability: Math.max(0, Math.min(100, Math.round(raw * 100))),
    rawScore: raw,
    mediaKind,
    topGenerator: generators[0] ?? null,
    generators,
  };
}

function band(score: number): string {
  return score >= 75 ? "VERY HIGH" : score >= 50 ? "HIGH" : score >= 25 ? "MODERATE" : score >= 10 ? "LOW" : "VERY LOW";
}

function prettyGenerator(name: string): string {
  return name
    .split(/[_\-.]/)
    .filter(Boolean)
    .map((p) => (p.length <= 3 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1)))
    .join(" ");
}

/**
 * Replaces the locally-heuristic AI-generation score with the real Sightengine
 * result, keeping every deterministic local signal (metadata, JPEG structure,
 * pixel statistics) as supporting context. Report shape is unchanged.
 */
export function applyAiDetection<
  T extends {
    aiProbability: number;
    aiBand: string;
    manipulationProbability: number;
    riskLevel: string;
    summary: string;
    signals: { key: string; label: string; value: string; status: "supportive" | "inconsistent" | "unavailable"; detail: string }[];
    signalBreakdown: { signal: string; weight: number; normalized: number; contribution: number; scope: "ai" | "manipulation" }[];
    findings: { id: string; title: string; severity: "INFORMATIONAL" | "LOW" | "MODERATE" | "HIGH"; confidence: number; signalType: string; explanation: string }[];
  },
>(report: T, se: SightengineResult): T & { aiDetection: SightengineResult & { provider: string; topGeneratorLabel: string | null } } {
  const ai = se.aiProbability;
  const generatorLabel = se.topGenerator ? prettyGenerator(se.topGenerator.name) : null;
  const kind = se.mediaKind === "video" ? "video" : "image";

  const signals = [
    ...report.signals,
    {
      key: "ai-detection",
      label: "AI-generation detection (Sightengine genai)",
      value: `${ai}% (${band(ai)})`,
      status: (ai >= 50 ? "inconsistent" : "supportive") as "supportive" | "inconsistent" | "unavailable",
      detail: `The ${kind} was submitted to Sightengine's genai model, which returned type.ai_generated = ${se.rawScore.toFixed(4)}. This value is the reported AI-generation confidence.`,
    },
    ...(generatorLabel
      ? [
          {
            key: "ai-generator",
            label: "Most likely AI generator",
            value: `${generatorLabel} (${Math.round((se.topGenerator?.score ?? 0) * 100)}%)`,
            status: "inconsistent" as const,
            detail: `Generator-specific scores were returned; the highest-scoring model family is ${generatorLabel}.`,
          },
        ]
      : []),
  ];

  const breakdown = [
    {
      signal: "Sightengine genai AI-generation score",
      weight: 100,
      normalized: Number(se.rawScore.toFixed(4)),
      contribution: ai,
      scope: "ai" as const,
    },
    ...report.signalBreakdown.filter((b) => b.scope === "manipulation"),
  ];

  const findings = [
    {
      id: "ai-detection",
      title:
        ai >= 50
          ? "AI-generation detected by Sightengine"
          : "No AI-generation indication returned by Sightengine",
      severity: (ai >= 75 ? "HIGH" : ai >= 50 ? "MODERATE" : ai >= 25 ? "LOW" : "INFORMATIONAL") as
        | "INFORMATIONAL"
        | "LOW"
        | "MODERATE"
        | "HIGH",
      confidence: ai >= 50 ? ai : 100 - ai,
      signalType: "Sightengine genai model",
      explanation: `Sightengine's AI-generated-content model returned an AI-generation confidence of ${ai}% for this ${kind}.${
        generatorLabel ? ` The most likely generator family reported is ${generatorLabel}.` : ""
      }`,
    },
    ...report.findings.filter((f) => f.id !== "ai-detection"),
  ];

  const combined = Math.max(ai, report.manipulationProbability) * 0.7 + Math.min(ai, report.manipulationProbability) * 0.3;
  const riskLevel = combined >= 75 ? "CRITICAL" : combined >= 50 ? "HIGH" : combined >= 25 ? "MODERATE" : "LOW";

  return {
    ...report,
    aiProbability: ai,
    aiBand: band(ai),
    riskLevel,
    signals,
    signalBreakdown: breakdown,
    findings,
    summary: `${report.summary} AI-generation likelihood is reported by Sightengine's genai model as ${ai}% (${band(ai)})${
      generatorLabel ? `, most consistent with ${generatorLabel}` : ""
    }.`,
    aiDetection: { ...se, provider: "Sightengine genai", topGeneratorLabel: generatorLabel },
  } as T & { aiDetection: SightengineResult & { provider: string; topGeneratorLabel: string | null } };
}
