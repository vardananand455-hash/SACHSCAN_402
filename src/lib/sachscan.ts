import { supabase } from "@/integrations/supabase/client";

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // configurable upload ceiling

/* --------------- evidence kinds ---------------
 * The image whitelist below is unchanged from the image-only build; the video
 * and text lists are additive so image intake behaviour cannot regress. */
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp"];
export const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
export const VIDEO_EXT = [".mp4", ".webm", ".mov"];
export const TEXT_TYPES = [
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
export const TEXT_EXT = [".txt", ".md", ".pdf", ".docx"];

export const ACCEPTED_TYPES = [...IMAGE_TYPES, ...VIDEO_TYPES, ...TEXT_TYPES];
export const ACCEPTED_EXT = [...IMAGE_EXT, ...VIDEO_EXT, ...TEXT_EXT];

export type EvidenceKind = "image" | "video" | "text" | "unsupported";

/** Single source of truth for intake validation AND analysis dispatch. */
export function evidenceKind(fileName: string, mimeType: string | null | undefined): EvidenceKind {
  const name = (fileName ?? "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const mime = (mimeType ?? "").toLowerCase();
  if (IMAGE_TYPES.includes(mime) || IMAGE_EXT.includes(ext)) return "image";
  if (mime.startsWith("video/") || VIDEO_EXT.includes(ext)) {
    return VIDEO_TYPES.includes(mime) || VIDEO_EXT.includes(ext) ? "video" : "unsupported";
  }
  if (TEXT_TYPES.includes(mime) || TEXT_EXT.includes(ext) || mime.startsWith("text/")) return "text";
  return "unsupported";
}

export const EVIDENCE_KIND_LABEL: Record<string, string> = {
  image: "Image",
  video: "Video",
  text: "Text",
  unsupported: "Unknown",
};


export const DISCLAIMER =
  "Prototype forensic assessment — results are probabilistic indicators, not a definitive determination of authenticity.";

export interface Investigation {
  id: string;
  case_id: string;
  investigator_name: string | null;
  evidence_name: string | null;
  evidence_type: string | null;
  evidence_description: string | null;
  status: string | null;
  ai_probability: number | null;
  manipulation_probability: number | null;
  authenticity_confidence: number | null;
  risk_level: string | null;
  metadata_status: string | null;
  source_trace_status: string | null;
  summary: string | null;
  is_demo: boolean | null;
  created_at: string;
}

export interface EvidenceRow {
  id: string;
  investigation_id: string;
  file_name: string | null;
  file_type: string | null;
  file_size: number | null;
  file_url: string | null;
  file_hash: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface AnalysisRow {
  id: string;
  investigation_id: string;
  file_hash: string | null;
  ai_probability: number | null;
  manipulation_probability: number | null;
  authenticity_confidence: number | null;
  risk_level: string | null;
  findings: unknown;
  signals: unknown;
  created_at: string;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function generateCaseId(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => alphabet[b % alphabet.length])
    .join("");
  return `SS-${stamp}-${rand}`;
}

export function bandLabel(score: number | null | undefined): string {
  if (score === null || score === undefined) return "—";
  if (score <= 20) return "Low";
  if (score <= 40) return "Mild";
  if (score <= 60) return "Moderate";
  if (score <= 80) return "High";
  return "Very High";
}

export function riskColorVar(risk: string | null | undefined): string {
  switch ((risk ?? "").toUpperCase()) {
    case "LOW":
      return "var(--ok)";
    case "MODERATE":
      return "var(--warn)";
    case "HIGH":
      return "var(--high)";
    case "CRITICAL":
      return "var(--critical)";
    default:
      return "var(--muted-foreground)";
  }
}

export function scoreColorVar(score: number | null | undefined): string {
  if (score === null || score === undefined) return "var(--muted-foreground)";
  if (score <= 20) return "var(--ok)";
  if (score <= 40) return "var(--warn)";
  if (score <= 60) return "var(--warn)";
  if (score <= 80) return "var(--high)";
  return "var(--critical)";
}

export const RISK_WORDING: Record<string, string> = {
  LOW: "No meaningful concentration of suspicious indicators",
  MODERATE: "Some indicators warrant review",
  HIGH: "Notable concentration of suspicious indicators",
  CRITICAL: "High concentration of suspicious indicators",
};

/* ---------------- data access (client, RLS-scoped) ---------------- */

export async function fetchInvestigations(): Promise<Investigation[]> {
  const { data, error } = await supabase
    .from("investigations")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as Investigation[];
}

export async function fetchInvestigation(id: string): Promise<Investigation> {
  const { data, error } = await supabase.from("investigations").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Investigation record not found.");
  return data as unknown as Investigation;
}

export async function fetchCaseBundle(id: string): Promise<{
  investigation: Investigation;
  evidence: EvidenceRow | null;
  analysis: AnalysisRow | null;
  sourceMatches: {
    id: string;
    source_name: string | null;
    source_url: string | null;
    similarity_score: number | null;
    confidence: number | null;
    discovered_date: string | null;
    is_demo: boolean | null;
  }[];
  previewUrl: string | null;
}> {
  const investigation = await fetchInvestigation(id);
  const [ev, an, sm] = await Promise.all([
    supabase
      .from("evidence")
      .select("*")
      .eq("investigation_id", id)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("analysis_results")
      .select("*")
      .eq("investigation_id", id)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase.from("source_matches").select("*").eq("investigation_id", id),
  ]);
  const evidence = (ev.data?.[0] ?? null) as unknown as EvidenceRow | null;
  const analysis = (an.data?.[0] ?? null) as unknown as AnalysisRow | null;

  let previewUrl: string | null = null;
  if (evidence?.file_url) {
    const signed = await supabase.storage.from("evidence").createSignedUrl(evidence.file_url, 3600);
    previewUrl = signed.data?.signedUrl ?? null;
  }

  return {
    investigation,
    evidence,
    analysis,
    sourceMatches: (sm.data ?? []) as never[],
    previewUrl,
  };
}
