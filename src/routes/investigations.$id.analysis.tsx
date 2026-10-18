import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { analyzeEvidence } from "@/lib/forensics.functions";
import { analyzeTextEvidence } from "@/lib/text-forensics.functions";
import { analyzeVideoEvidence } from "@/lib/video-forensics.functions";
import { evidenceKind, type EvidenceKind } from "@/lib/sachscan";
import { Disclaimer, PageShell, Panel } from "@/components/forensic/ui";

export const Route = createFileRoute("/investigations/$id/analysis")({
  head: () => ({
    meta: [
      { title: "Analysis in Progress — SACHSCAN" },
      {
        name: "description",
        content:
          "Sequential forensic examination of ingested evidence: integrity verification, metadata extraction, pixel, linguistic and temporal signal analysis.",
      },
      { property: "og:title", content: "Analysis in Progress — SACHSCAN" },
      { property: "og:description", content: "Deterministic forensic examination of the ingested evidence file." },
    ],
  }),
  component: AnalysisProgress,
});

/**
 * Pipeline definition.
 *
 * Every stage's state is driven exclusively by the real asynchronous operation
 * it belongs to — no timer ever advances or completes a stage. Stages performed
 * inside a single server round-trip share one `phase`: they enter RUNNING when
 * that request is dispatched and COMPLETED only when it resolves.
 *
 * The stage list and the examination call are selected by evidence kind. The
 * image branch is byte-for-byte the previous behaviour.
 */
type Phase = "ingest" | "examine" | "persist" | "finalize";
type StageState = "PENDING" | "RUNNING" | "COMPLETED" | "ERROR";

const IMAGE_STAGES: { label: string; phase: Phase }[] = [
  { label: "Evidence ingestion", phase: "ingest" },
  { label: "File integrity verification", phase: "examine" },
  { label: "Metadata extraction", phase: "examine" },
  { label: "Image characteristics analysis", phase: "examine" },
  { label: "Manipulation signal analysis", phase: "examine" },
  { label: "AI-generation indicator analysis", phase: "examine" },
  { label: "Regional forensic analysis", phase: "examine" },
  { label: "Confidence calculation", phase: "examine" },
  { label: "Saving assessment", phase: "persist" },
  { label: "Finalizing investigation", phase: "finalize" },
];

const TEXT_STAGES: { label: string; phase: Phase }[] = [
  { label: "Specimen ingestion", phase: "ingest" },
  { label: "Specimen integrity verification", phase: "examine" },
  { label: "Sentence & paragraph structure analysis", phase: "examine" },
  { label: "Lexical diversity analysis", phase: "examine" },
  { label: "Repetition & phrasing analysis", phase: "examine" },
  { label: "Punctuation & transition analysis", phase: "examine" },
  { label: "Confidence calculation", phase: "examine" },
  { label: "Saving assessment", phase: "persist" },
  { label: "Finalizing investigation", phase: "finalize" },
];

const VIDEO_STAGES: { label: string; phase: Phase }[] = [
  { label: "Evidence ingestion", phase: "ingest" },
  { label: "Container decoding & frame sampling", phase: "ingest" },
  { label: "Per-frame pixel analysis", phase: "examine" },
  { label: "Cross-frame consistency analysis", phase: "examine" },
  { label: "Confidence calculation", phase: "examine" },
  { label: "Saving assessment", phase: "persist" },
  { label: "Finalizing investigation", phase: "finalize" },
];

const PHASE_ORDER: Phase[] = ["ingest", "examine", "persist", "finalize"];

/** Hard per-phase ceilings. Nothing in this view can wait indefinitely. */
const PHASE_TIMEOUT_MS: Record<Phase, number> = {
  ingest: 30_000,
  examine: 45_000,
  persist: 30_000,
  finalize: 30_000,
};

const LABEL: Record<StageState, string> = {
  PENDING: "queued",
  RUNNING: "running",
  COMPLETED: "complete",
  ERROR: "failed",
};

function withTimeout<T>(work: Promise<T>, phase: Phase, description: string, ms?: number): Promise<T> {
  const limit = ms ?? PHASE_TIMEOUT_MS[phase];
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${description} did not complete within ${limit / 1000} seconds. The evidence file may be too large or unreadable — retry, or re-upload a smaller copy.`,
          ),
        ),
      limit,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function AnalysisProgress() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const analyzeImage = useServerFn(analyzeEvidence);
  const analyzeText = useServerFn(analyzeTextEvidence);
  const analyzeVideo = useServerFn(analyzeVideoEvidence);

  const [kind, setKind] = useState<EvidenceKind | null>(null);
  const [frameProgress, setFrameProgress] = useState<{ done: number; total: number } | null>(null);
  const [phases, setPhases] = useState<Record<Phase, StageState>>({
    ingest: "PENDING",
    examine: "PENDING",
    persist: "PENDING",
    finalize: "PENDING",
  });
  const [error, setError] = useState<{ phase: Phase; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cancelled = useRef(false);

  const set = useCallback((phase: Phase, state: StageState) => {
    setPhases((p) => ({ ...p, [phase]: state }));
  }, []);

  useEffect(() => {
    cancelled.current = false;

    (async () => {
      setError(null);
      setFrameProgress(null);
      setPhases({ ingest: "PENDING", examine: "PENDING", persist: "PENDING", finalize: "PENDING" });
      let current: Phase = "ingest";
      try {
        // 1. Ingestion — the stored evidence row for this investigation.
        set("ingest", "RUNNING");
        const ev = await withTimeout(
          (async () => {
            const { data, error: e } = await supabase
              .from("evidence")
              .select("file_url,file_name,file_type")
              .eq("investigation_id", id)
              .order("created_at", { ascending: false })
              .limit(1);
            if (e) throw new Error(e.message);
            const row = data?.[0];
            if (!row?.file_url) throw new Error("No evidence file is attached to this investigation.");
            return row;
          })(),
          "ingest",
          "Evidence ingestion",
        );
        if (cancelled.current) return;

        const mediaKind = evidenceKind(ev.file_name ?? "", ev.file_type ?? "");
        setKind(mediaKind);
        const filePath = String(ev.file_url);
        if (mediaKind === "unsupported") {
          throw new Error("This evidence type cannot be examined by any available engine.");
        }

        // Video: the container is decoded and sampled in the browser, because
        // frame decoding is not available in the server runtime. The sample
        // timestamps are fixed, so the sampling is fully repeatable.
        let framePayload: Awaited<ReturnType<typeof import("@/lib/video-frames").extractVideoFrames>> | null = null;
        if (mediaKind === "video") {
          framePayload = await withTimeout(
            (async () => {
              const signed = await supabase.storage.from("evidence").createSignedUrl(filePath, 300);
              if (!signed.data?.signedUrl) {
                throw new Error("The stored video could not be opened for frame sampling.");
              }
              const blob = await (await fetch(signed.data.signedUrl)).blob();
              const { extractVideoFrames } = await import("@/lib/video-frames");
              return await extractVideoFrames(
                new File([blob], ev.file_name ?? "evidence.mp4", { type: ev.file_type || "video/mp4" }),
                (done, total) => setFrameProgress({ done, total }),
              );
            })(),
            "ingest",
            "Container decoding and frame sampling",
            90_000,
          );
          if (cancelled.current) return;
        }
        set("ingest", "COMPLETED");

        // 2. Examination — one server round-trip per evidence kind.
        current = "examine";
        set("examine", "RUNNING");
        set("persist", "RUNNING");

        const examine = () => {
          if (mediaKind === "text") {
            return analyzeText({
              data: {
                investigationId: id,
                textPath: `${filePath}.extracted.txt`,
                fileName: ev.file_name ?? "specimen.txt",
                declaredMime: ev.file_type ?? "text/plain",
                extractedFrom: (ev.file_name ?? "").toLowerCase().endsWith(".pdf")
                  ? "PDF EXTRACTION"
                  : (ev.file_name ?? "").toLowerCase().endsWith(".docx")
                    ? "DOCX EXTRACTION"
                    : "PLAIN TEXT",
              },
            });
          }
          if (mediaKind === "video" && framePayload) {
            return analyzeVideo({
              data: {
                investigationId: id,
                storagePath: filePath,
                fileName: ev.file_name ?? "evidence.mp4",
                fileType: ev.file_type || "video/mp4",
                container: framePayload.container,
                frames: framePayload.frames.map((f) => ({
                  index: f.index,
                  timestamp: f.timestamp,
                  pngBase64: f.pngBase64,
                  width: f.width,
                  height: f.height,
                })),
              },
            });
          }
          return analyzeImage({
            data: {
              investigationId: id,
              storagePath: filePath,
              fileName: ev.file_name ?? "evidence",
              fileType: ev.file_type ?? "",
            },
          });
        };

        const result = await withTimeout(
          examine(),
          "examine",
          "The forensic examination",
          mediaKind === "video" ? 90_000 : undefined,
        );
        if (cancelled.current) return;
        if (!result?.ok) throw new Error("The examination returned no result.");
        set("examine", "COMPLETED");
        set("persist", "COMPLETED");

        // 3. Finalization — confirm the persisted record is readable before the
        //    Results page is opened, so navigation never precedes real success.
        current = "finalize";
        set("finalize", "RUNNING");
        await withTimeout(
          (async () => {
            const { data, error: e } = await supabase
              .from("investigations")
              .select("id,status")
              .eq("id", id)
              .maybeSingle();
            if (e) throw new Error(e.message);
            if (!data) throw new Error("The investigation record could not be re-read after saving.");
            if (data.status !== "complete") {
              throw new Error(`The investigation was saved with status "${data.status ?? "unknown"}" instead of complete.`);
            }
          })(),
          "finalize",
          "Finalizing the investigation",
        );
        if (cancelled.current) return;
        set("finalize", "COMPLETED");
        navigate({ to: "/investigations/$id", params: { id } });
      } catch (e) {
        if (cancelled.current) return;
        const message = (e as Error).message;
        console.error(`[sachscan] analysis pipeline failed during "${current}":`, message);
        set(current, "ERROR");
        if (current === "examine") set("persist", "PENDING");
        setError({ phase: current, message });
      }
    })();

    return () => {
      cancelled.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, attempt]);

  const stageState = (phase: Phase): StageState => (error?.phase === phase ? "ERROR" : phases[phase]!);
  const done = PHASE_ORDER.every((p) => phases[p] === "COMPLETED");
  const stages = kind === "text" ? TEXT_STAGES : kind === "video" ? VIDEO_STAGES : IMAGE_STAGES;

  return (
    <PageShell title="Forensic analysis" subtitle="Case intake — step 3 of 3. Examination runs server-side.">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel title="Examination stages">
          <ol className="space-y-1">
            {stages.map((stage) => {
              const state = stageState(stage.phase);
              return (
                <li
                  key={stage.label}
                  className={`flex items-center gap-3 rounded px-2 py-2 text-sm transition-colors ${
                    state === "RUNNING" ? "bg-surface-2" : ""
                  }`}
                >
                  {state === "ERROR" ? (
                    <XCircle className="size-4 text-destructive" />
                  ) : state === "COMPLETED" ? (
                    <CheckCircle2 className="size-4" style={{ color: "var(--ok)" }} />
                  ) : state === "RUNNING" ? (
                    <Loader2 className="size-4 animate-spin text-primary" />
                  ) : (
                    <span className="size-4 rounded-full border border-border" />
                  )}
                  <span className={state === "PENDING" ? "text-muted-foreground" : ""}>{stage.label}</span>
                  <span className="mono ml-auto text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {stage.label.includes("frame sampling") && frameProgress && state === "RUNNING"
                      ? `${frameProgress.done}/${frameProgress.total}`
                      : LABEL[state]}
                  </span>
                </li>
              );
            })}
          </ol>

          {error ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span>Analysis failed: {error.message}</span>
              <button
                onClick={() => setAttempt((a) => a + 1)}
                className="inline-flex items-center gap-1.5 rounded border border-destructive/50 px-2.5 py-1 text-xs"
              >
                <RefreshCw className="size-3.5" /> Retry analysis
              </button>
            </div>
          ) : null}

          {done ? (
            <p className="mt-4 text-sm" style={{ color: "var(--ok)" }}>
              Examination complete. Opening the assessment…
            </p>
          ) : null}
        </Panel>

        <div className="space-y-4">
          <Panel title="Method">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {kind === "text"
                ? "Text evidence is examined by a deterministic linguistic engine: sentence-length variance and burstiness, lexical diversity, repeated phrasing, punctuation variety, paragraph regularity and transitional-phrase density. It is a heuristic engine, not a trained classifier, and specimens under 50 words are reported as insufficient evidence rather than scored."
                : kind === "video"
                  ? "Video evidence is sampled at fixed timestamps across the first 60 seconds. Each sampled frame is examined by the same pixel-level engine used for image evidence, then the frames are compared to each other for noise, texture and edge consistency. Every value is computed from the decoded frames; nothing is randomised."
                  : "All local signals are computed deterministically from the bytes of the stored evidence file: byte-header format verification, EXIF/XMP parsing, JPEG quantisation and chroma-subsampling inspection, sampled luminance, noise, edge-energy and entropy statistics, per-tile regional deviation measurement, and C2PA detection. AI-generation likelihood comes from the configured external detection provider; no value is randomised or fabricated."}
            </p>
          </Panel>
          <Disclaimer />
        </div>
      </div>
    </PageShell>
  );
}
