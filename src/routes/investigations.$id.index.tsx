import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  FileText,
  Fingerprint,
  Lock,
} from "lucide-react";

import {
  fetchCaseBundle,
  bandLabel,
  formatBytes,
  RISK_WORDING,
  scoreColorVar,
} from "@/lib/sachscan";

import {
  asReport,
  type StoredFinding,
  type StoredReport,
  type StoredSignal,
} from "@/lib/forensic-report";

import {
  DemoBadge,
  Disclaimer,
  HeuristicTag,
  KeyValue,
  MetricCard,
  PageShell,
  Panel,
  RiskBadge,
  ScoreRing,
  SignalIcon,
  StatusChip,
} from "@/components/forensic/ui";

export const Route = createFileRoute(
  "/investigations/$id/",
)({
  head: () => ({
    meta: [
      {
        title: "Investigation Assessment — SACHSCAN",
      },
      {
        name: "description",
        content:
          "Forensic assessment of an evidence item: AI-generation likelihood, manipulation likelihood, authenticity confidence and verification signals.",
      },
      {
        property: "og:title",
        content:
          "Investigation Assessment — SACHSCAN",
      },
      {
        property: "og:description",
        content:
          "Evidence-level forensic assessment with traceable signal breakdown.",
      },
    ],
  }),

  component: Results,
});

const TABS = [
  "Overview",
  "Metadata",
  "Findings",
  "Source trace",
] as const;

interface SourceTraceResponse {
  success?: boolean;
  submittedUrl?: string;
  disclaimer?: string;
  sourceTracing?: {
    fetch?: unknown;
    search?: unknown;
    warning?: string | null;
  };
  error?: string;
}

function collectSourceUrls(value: unknown, output = new Set<string>(), depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) {
    return Array.from(output);
  }

  if (typeof value === "string") {
    const matches = value.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    for (const candidate of matches) {
      try {
        const parsed = new URL(candidate.replace(/[.,;]+$/, ""));
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          output.add(parsed.toString());
        }
      } catch {
        // Ignore malformed URLs returned in page text.
      }
    }
    return Array.from(output);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSourceUrls(item, output, depth + 1);
    }
    return Array.from(output);
  }

  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectSourceUrls(item, output, depth + 1);
    }
  }

  return Array.from(output);
}

function Results() {
  const { id } = Route.useParams();

  const [tab, setTab] =
    useState<(typeof TABS)[number]>("Overview");

  const [sourceTraceUrl, setSourceTraceUrl] = useState("");
  const [sourceTraceLoading, setSourceTraceLoading] = useState(false);
  const [sourceTraceError, setSourceTraceError] = useState<string | null>(null);
  const [sourceTraceResult, setSourceTraceResult] = useState<SourceTraceResponse | null>(null);
  const autoTraceStarted = useRef(false);

  async function executeSourceTrace(rawUrl: string) {
    setSourceTraceError(null);
    setSourceTraceResult(null);

    let candidate: URL;
    try {
      candidate = new URL(rawUrl.trim());
      if (candidate.protocol !== "https:" && candidate.protocol !== "http:") {
        throw new Error("Only public HTTP and HTTPS URLs are supported.");
      }
    } catch (error) {
      setSourceTraceError(
        error instanceof Error ? error.message : "Enter a valid public URL.",
      );
      return;
    }

    setSourceTraceUrl(candidate.toString());
    setSourceTraceLoading(true);
    try {
      const response = await fetch("/api/source-trace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ investigationId: id, url: candidate.toString() }),
      });

      const payload = (await response.json()) as SourceTraceResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? `Source tracing failed (HTTP ${response.status}).`);
      }

      setSourceTraceResult(payload);
    } catch (error) {
      setSourceTraceError(
        error instanceof Error ? error.message : "Source tracing could not be completed.",
      );
    } finally {
      setSourceTraceLoading(false);
    }
  }

  async function runSourceTrace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await executeSourceTrace(sourceTraceUrl);
  }

  const discoveredSourceUrls = sourceTraceResult
    ? collectSourceUrls(sourceTraceResult.sourceTracing)
    : [];

  const {
    data,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["case", id],
    queryFn: () => fetchCaseBundle(id),
  });

  useEffect(() => {
    if (!data || autoTraceStarted.current) return;

    const sourceUrl = new URLSearchParams(window.location.search).get("sourceUrl");
    if (!sourceUrl) return;

    const signals = (data.analysis?.signals ?? {}) as {
      verificationTier?: string;
      verificationStatus?: string;
    };
    const premiumAccess = Boolean(data.investigation.is_demo) || (
      signals.verificationTier === "full" && signals.verificationStatus === "paid"
    );
    if (!premiumAccess) return;

    autoTraceStarted.current = true;
    setTab("Source trace");
    setSourceTraceUrl(sourceUrl);
    void executeSourceTrace(sourceUrl);
  }, [data, id]);

  if (isLoading) {
    return (
      <PageShell
        title="Investigation"
        subtitle="Loading case record…"
      >
        <Panel>
          <p className="text-sm text-muted-foreground">
            Retrieving the assessment from the case
            database…
          </p>
        </Panel>
      </PageShell>
    );
  }

  if (error || !data) {
    return (
      <PageShell
        title="Investigation"
        subtitle="Case record unavailable"
      >
        <Panel>
          <p className="text-sm text-destructive">
            {(error as Error)?.message ??
              "Case record could not be loaded."}
          </p>

          <button
            onClick={() => refetch()}
            className="mt-3 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[13px]"
          >
            Retry
          </button>
        </Panel>
      </PageShell>
    );
  }

  const {
    investigation: inv,
    evidence,
    analysis,
    sourceMatches,
    previewUrl,
  } = data;

  const report = asReport(
    analysis?.signals,
  );

  const demo = Boolean(inv.is_demo);

  /*
   * --------------------------------
   * FULL VERIFICATION DETECTION
   * --------------------------------
   *
   * The paid premium-media endpoint adds:
   *
   * analysis.aiDetection.provider
   *
   * Standard/free analysis does not have this.
   *
   * Therefore detailed forensic information is
   * unlocked only after Full Verification.
   */

  const reportWithPremium =
    report as StoredReport & {
      aiDetection?: {
        provider?: string;
        aiProbability?: number;
        rawScore?: number;
        mediaKind?: "image" | "video";
        topGenerator?: {
          name: string;
          score: number;
        } | null;
        generators?: {
          name: string;
          score: number;
        }[];
      };
    };

  // Keep the results-page premium gate consistent with the heatmap route.
  // Demo cases remain accessible; real investigations require a paid Full
  // Verification marker persisted in the analysis signals.
  const verificationAccess = (analysis?.signals ?? {}) as {
    verificationTier?: string;
    verificationStatus?: string;
  };

  const isFullVerification =
    demo ||
    (verificationAccess.verificationTier === "full" &&
      verificationAccess.verificationStatus === "paid");

  /*
   * ================================================
   * FREE / STANDARD VERIFICATION
   * ================================================
   *
   * IMPORTANT:
   *
   * Free users only see:
   *
   * 1. Overall AI Assessment
   * 2. AI generation likelihood
   * 3. Confidence Score
   *
   * Nothing else is exposed here.
   *
   * No:
   * - Metadata
   * - Findings
   * - Source trace
   * - Heatmap
   * - Regional analysis
   * - Forensic signals
   * - Score trace
   * - Manipulation details
   * - EXIF
   * - C2PA
   */

  if (!isFullVerification) {
    return (
      <PageShell
        title={inv.case_id}
        subtitle={`${inv.evidence_name ?? "No evidence attached"} — Standard Verification`}
        actions={
          <>
            {demo ? <DemoBadge /> : null}

            <StatusChip status={inv.status} />
          </>
        }
      >
        {demo ? (
          <p
            className="mb-4 rounded-md border border-dashed px-3 py-2 text-xs"
            style={{
              borderColor: "var(--demo)",
              color: "var(--demo)",
            }}
          >
            DEMO CASE — this is a pre-written
            reference record for demonstration. It is
            not the output of a live analysis.
          </p>
        ) : null}

        {/* Free-tier navigation: premium sections stay visible but locked. */}
        <div className="mb-5 flex flex-wrap gap-1 border-b border-border" aria-label="Verification sections">
          <span className="inline-flex items-center gap-2 border-b-2 border-primary px-3 py-2 text-xs font-medium text-foreground">
            Overview
          </span>
          {["Metadata", "Findings", "Source trace", "Heatmap"].map((section) => (
            <Link
              key={section}
              to={section === "Heatmap" ? "/investigations/$id/heatmap" : "/investigations/$id/upload"}
              params={{ id }}
              title={`Unlock ${section} with Full Verification`}
              className="inline-flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              <Lock className="size-3" aria-hidden="true" />
              {section}
            </Link>
          ))}
        </div>

        {!analysis ? (
          <Panel title="Assessment pending">
            <p className="text-sm text-muted-foreground">
              No analysis result is stored for this
              investigation yet.
            </p>

            <Link
              to="/investigations/$id/upload"
              params={{ id }}
              className="mt-3 inline-block rounded-md bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground"
            >
              Ingest evidence
            </Link>
          </Panel>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-5">
            {/* =====================================
                OVERALL AI ASSESSMENT
               ===================================== */}

            <Panel
              title="Overall AI Assessment"
              right={<HeuristicTag />}
            >
              <div className="flex flex-col items-center py-8 text-center">
                <ScoreRing
                  value={
                    inv.ai_probability === null
                      ? null
                      : Number(
                          inv.ai_probability,
                        )
                  }
                  label="AI generation likelihood"
                  caption={`${bandLabel(
                    inv.ai_probability,
                  )} · ${
                    report?.aiBand ??
                    bandLabel(inv.ai_probability)
                  }`}
                />

                <div className="mt-6 max-w-xl">
                  <p className="text-sm font-medium">
                    {bandLabel(
                      inv.ai_probability,
                    )}
                  </p>

                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {inv.summary ??
                      "The evidence has been assessed for indications of AI generation."}
                  </p>
                </div>
              </div>
            </Panel>

            {/* =====================================
                CONFIDENCE SCORE
               ===================================== */}

            <Panel
              title="Confidence Score"
              right={
                <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  Assessment confidence
                </span>
              }
            >
              <div className="flex flex-col items-center py-8 text-center">
                <ScoreRing
                  value={
                    inv.authenticity_confidence ===
                    null
                      ? null
                      : Number(
                          inv.authenticity_confidence,
                        )
                  }
                  label="Confidence"
                  color="var(--primary)"
                  caption={
                    report?.confidenceStatus ===
                    "INSUFFICIENT_EVIDENCE"
                      ? "Insufficient evidence"
                      : "Assessed"
                  }
                />

                <p className="mt-5 max-w-xl text-xs leading-relaxed text-muted-foreground">
                  {report?.confidenceReason ??
                    "Confidence reflects the amount and consistency of evidence available to the assessment."}
                </p>
              </div>
            </Panel>

            {/* =====================================
                PREMIUM CTA
               ===================================== */}

            <Panel
              title="Full Verification"
              right={
                <span className="mono rounded-sm border border-primary px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-primary">
                  PREMIUM
                </span>
              }
            >
              <div className="flex items-start gap-3">
                <div className="rounded-md border border-border p-2">
                  <Lock className="size-4 text-primary" />
                </div>

                <div>
                  <p className="text-sm font-medium">
                    Unlock Full Verification
                  </p>

                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Unlock detailed forensic analysis,
                    metadata, manipulation signals,
                    C2PA detection, regional analysis,
                    AI detection heatmap, source tracing
                    and detailed AI verification.
                  </p>

                  <p className="mt-2 text-xs font-medium text-primary">
                    Full Verification — 0.01 USDC
                  </p>

                  <Link
                    to="/investigations/$id/upload"
                    params={{ id }}
                    className="mt-3 inline-flex rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
                  >
                    Start Full Verification
                  </Link>
                </div>
              </div>
            </Panel>
          </div>
        )}
      </PageShell>
    );
  }

  /*
   * ================================================
   * FULL VERIFICATION
   * ================================================
   *
   * Everything below is only accessible after the
   * paid x402 verification result exists.
   */

  return (
    <PageShell
      title={inv.case_id}
      subtitle={`${inv.evidence_name ?? "No evidence attached"} — examined by ${
        inv.investigator_name ?? "unattributed"
      }`}
      actions={
        <>
          {demo ? <DemoBadge /> : null}

          <StatusChip status={inv.status} />

          <RiskBadge risk={inv.risk_level} />

          <Link
            to="/investigations/$id/report"
            params={{ id }}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3.5 py-2 text-[13px] hover:bg-accent"
          >
            <FileText className="size-4" />
            Report
          </Link>
        </>
      }
    >
      {demo ? (
        <p
          className="mb-4 rounded-md border border-dashed px-3 py-2 text-xs"
          style={{
            borderColor: "var(--demo)",
            color: "var(--demo)",
          }}
        >
          DEMO CASE — this is a pre-written
          reference record for demonstration. It is
          not the output of a live analysis.
        </p>
      ) : null}

      {!analysis && !demo ? (
        <Panel title="Assessment pending">
          <p className="text-sm text-muted-foreground">
            No analysis result is stored for this
            investigation yet.
          </p>

          <Link
            to="/investigations/$id/upload"
            params={{ id }}
            className="mt-3 inline-block rounded-md bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground"
          >
            Ingest evidence
          </Link>
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">

          {/* =====================================
              FULL VERIFICATION SCORES
             ===================================== */}

          <div className="grid gap-4 sm:grid-cols-3">
            <ScoreRing
              value={
                inv.ai_probability === null
                  ? null
                  : Number(
                      inv.ai_probability,
                    )
              }
              label="AI generation likelihood"
              caption={`${bandLabel(
                inv.ai_probability,
              )} · ${
                report?.aiBand ??
                bandLabel(inv.ai_probability)
              }`}
            />

            <ScoreRing
              value={
                inv.manipulation_probability ===
                null
                  ? null
                  : Number(
                      inv.manipulation_probability,
                    )
              }
              label="Manipulation likelihood"
              caption={bandLabel(
                inv.manipulation_probability,
              )}
            />

            <ScoreRing
              value={
                inv.authenticity_confidence ===
                null
                  ? null
                  : Number(
                      inv.authenticity_confidence,
                    )
              }
              label="Authenticity confidence"
              color="var(--primary)"
              caption={
                report?.confidenceStatus ===
                "INSUFFICIENT_EVIDENCE"
                  ? "Insufficient evidence"
                  : "Assessed"
              }
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <MetricCard
              label="Overall risk"
              value={inv.risk_level ?? "—"}
              sub={
                RISK_WORDING[
                  (
                    inv.risk_level ?? ""
                  ).toUpperCase()
                ] ??
                "Risk banding unavailable"
              }
              color={scoreColorVar(
                Math.max(
                  Number(
                    inv.ai_probability ?? 0,
                  ),
                  Number(
                    inv.manipulation_probability ??
                      0,
                  ),
                ),
              )}
            />

            <MetricCard
              label="Verification"
              value="FULL"
              sub="Paid Full Verification completed"
            />
          </div>

          {/* =====================================
              OVERALL ASSESSMENT
             ===================================== */}

          <Panel
            title="Overall assessment"
            right={<HeuristicTag />}
          >
            <p className="text-sm leading-relaxed">
              {inv.summary ??
                "No assessment summary is stored for this case."}
            </p>
          </Panel>

          {/* =====================================
              WHY THIS RESULT
             ===================================== */}

          {report ? (
            <WhyThisResult
              report={report}
            />
          ) : null}

          {/* =====================================
              TABS
             ===================================== */}

          <div className="flex flex-wrap gap-1 border-b border-border">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`mono -mb-px border-b-2 px-3 py-2 text-[11px] uppercase tracking-[0.14em] transition-colors ${
                  tab === t
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}

            <Link
              to="/investigations/$id/heatmap"
              params={{ id }}
              className="mono -mb-px border-b-2 border-transparent px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-primary transition-colors hover:text-foreground"
            >
              AI detection heatmap
            </Link>
          </div>

          {/* =====================================
              OVERVIEW
             ===================================== */}

          {tab === "Overview" ? (
            <Panel
              title="Full forensic evidence"
              right={<HeuristicTag />}
            >
              {report ? (
                <>
                  <SignalList
                    signals={report.signals}
                  />

                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <ScopeChecklist
                      title={`AI-generation assessment: ${report.aiBand}`}
                      signals={report.signals.filter(
                        (s) =>
                          [
                            "software",
                            "dimensions",
                            "noise",
                            "luminance",
                            "c2pa",
                          ].includes(s.key),
                      )}
                    />

                    <ScopeChecklist
                      title={`Manipulation assessment: ${report.manipulationBand}`}
                      signals={report.signals.filter(
                        (s) =>
                          [
                            "quantization",
                            "chroma",
                            "camera",
                            "format",
                          ].includes(s.key),
                      )}
                    />
                  </div>

                  <p className="mt-4 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
                    Confidence:{" "}
                    {
                      report.authenticityConfidence
                    }
                    /100 —{" "}
                    {report.confidenceReason}
                  </p>

                  {report.regional ? (
                    <div className="mt-4 rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="mono text-[11px] font-semibold uppercase tracking-[0.14em]">
                          Regional forensic
                          analysis
                        </h3>

                        <Link
                          to="/investigations/$id/heatmap"
                          params={{ id }}
                          className="mono ml-auto text-[10px] uppercase tracking-[0.12em] text-primary hover:underline"
                        >
                          Open signal map
                        </Link>
                      </div>

                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        {
                          report.regional
                            .summary
                        }
                      </p>
                    </div>
                  ) : null}

                  <ScoreTrace
                    report={report}
                  />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No analysis result is available for
                  this record.
                </p>
              )}
            </Panel>
          ) : null}

          {/* =====================================
              METADATA
             ===================================== */}

          {tab === "Metadata" ? (
            <div className="space-y-4">
              <Panel title="File information">
                <KeyValue
                  items={[
                    {
                      k: "File name",
                      v:
                        evidence?.file_name ??
                        inv.evidence_name ??
                        "—",
                      mono: true,
                    },
                    {
                      k: "Declared MIME type",
                      v:
                        evidence?.file_type ??
                        inv.evidence_type ??
                        "—",
                      mono: true,
                    },
                    {
                      k: "Verified format (byte header)",
                      v:
                        report?.file
                          .detectedFormat ??
                        "—",
                      mono: true,
                    },
                    {
                      k: "Size",
                      v: formatBytes(
                        evidence?.file_size ??
                          report?.file.byteSize ??
                          null,
                      ),
                      mono: true,
                    },
                    {
                      k: "Dimensions",
                      v:
                        evidence?.width &&
                        evidence?.height
                          ? `${evidence.width} × ${evidence.height}`
                          : report?.file.width
                            ? `${report.file.width} × ${report.file.height}`
                            : "—",
                      mono: true,
                    },
                    {
                      k: "Aspect ratio",
                      v:
                        report?.file
                          .aspectRatio ??
                        "—",
                      mono: true,
                    },
                    {
                      k: "SHA-256",
                      v:
                        evidence?.file_hash ??
                        report?.fileHash ??
                        "—",
                      mono: true,
                    },
                  ]}
                />
              </Panel>

              <Panel
                title="EXIF / XMP information"
                right={
                  <span className="mono rounded-sm border border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]">
                    {(
                      report?.metadataStatus ??
                      inv.metadata_status ??
                      "UNKNOWN"
                    ).replace("_", " ")}
                  </span>
                }
              >
                {report ? (
                  <>
                    <KeyValue
                      items={Object.entries(
                        report.exif,
                      ).map(([k, v]) => ({
                        k,
                        v:
                          v === null ||
                          v === ""
                            ? "Not present"
                            : String(v),
                        mono: true,
                      }))}
                    />

                    <p className="mt-3 text-xs text-muted-foreground">
                      {
                        report.metadataStatusReason
                      }
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No parsed metadata block is
                    stored for this record.
                  </p>
                )}

                <p className="mt-3 text-xs text-muted-foreground">
                  Missing metadata alone is not
                  evidence of manipulation or AI
                  generation. Screenshots,
                  messaging-app downloads and
                  social-media exports can strip
                  metadata legitimately. Precise GPS
                  coordinates are never displayed —
                  only their presence is reported.
                </p>
              </Panel>

              {report ? (
                <Panel title="Image characteristics">
                  <KeyValue
                    items={[
                      {
                        k: "Pixel analysis",
                        v: report.imageStats
                          .available
                          ? "Completed"
                          : report.imageStats
                              .reason ??
                            "Unavailable",
                      },
                      {
                        k: "Luminance mean",
                        v:
                          report.imageStats
                            .luminanceMean ??
                          "—",
                        mono: true,
                      },
                      {
                        k: "Luminance σ",
                        v:
                          report.imageStats
                            .luminanceStdDev ??
                          "—",
                        mono: true,
                      },
                      {
                        k: "Noise floor (neighbour Δ)",
                        v:
                          report.imageStats
                            .noiseFloor ??
                          "—",
                        mono: true,
                      },
                      {
                        k: "Sampled pixels",
                        v:
                          report.imageStats
                            .sampledPixels ??
                          "—",
                        mono: true,
                      },
                      {
                        k: "JPEG est. quality",
                        v:
                          report.jpeg
                            .estimatedQuality ??
                          "—",
                        mono: true,
                      },
                      {
                        k: "Quantisation table Σ",
                        v:
                          report.jpeg
                            .quantizationSum ??
                          "—",
                        mono: true,
                      },
                      {
                        k: "Chroma subsampling",
                        v:
                          report.jpeg
                            .chromaSubsampling ??
                          "—",
                        mono: true,
                      },
                    ]}
                  />
                </Panel>
              ) : null}

              {report ? (
                <Panel title="Content credentials">
                  <KeyValue
                    items={[
                      {
                        k: "C2PA",
                        v: report.c2paPresent
                          ? "Present"
                          : "Not detected",
                        mono: true,
                      },
                    ]}
                  />
                </Panel>
              ) : null}
            </div>
          ) : null}

          {/* =====================================
              FINDINGS
             ===================================== */}

          {tab === "Findings" ? (
            <Panel
              title="Detailed forensic findings"
              right={<HeuristicTag />}
            >
              {report &&
              report.findings.length > 0 ? (
                <ul className="space-y-3">
                  {report.findings.map(
                    (f) => (
                      <FindingItem
                        key={f.id}
                        finding={f}
                      />
                    ),
                  )}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No structured findings are stored
                  for this record.
                </p>
              )}
            </Panel>
          ) : null}

          {/* =====================================
              SOURCE TRACE
             ===================================== */}

          {tab === "Source trace" ? (
            <div className="space-y-4">
              <Panel title="Provenance & source trace">
                <p className="mb-4 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  Source Trace reports provenance evidence found inside the
                  submitted file. It does not by itself prove who created,
                  published, or originally owned the content.
                </p>

                
              </Panel>

              <Panel title="Provenance interpretation">
                <ul className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                  <li><span className="font-medium text-foreground">Software:</span>{" "}A recorded software tag can indicate that the file was exported or processed by that software. It does not, by itself, establish manipulation or AI generation.</li>
                  <li><span className="font-medium text-foreground">Camera:</span>{" "}Camera make/model metadata is useful provenance evidence when present, but metadata can be removed or rewritten.</li>
                  <li><span className="font-medium text-foreground">C2PA:</span>{" "}A detected Content Credential is reported as provenance evidence. Absence of C2PA does not mean the content is inauthentic.</li>
                  <li><span className="font-medium text-foreground">GPS:</span>{" "}Only presence is shown here; precise coordinates remain hidden.</li>
                </ul>
              </Panel>

              <Panel title="Public source tracing">
                <div className="rounded-md border border-border bg-surface-2 p-3">
                  <div className="flex items-start gap-3">
                    <div className="rounded-md border border-border p-2">
                      <Fingerprint className="size-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Search accessible public sources</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Paste the original post/page URL. SACHSCAN will fetch accessible page content and search for indexed references.
                      </p>
                    </div>
                  </div>
                </div>

                <form onSubmit={runSourceTrace} className="mt-4 space-y-3">
                  <label htmlFor="source-trace-url" className="block text-xs font-medium">
                    Image, post, or webpage URL
                  </label>
                  <input
                    id="source-trace-url"
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    maxLength={4096}
                    required
                    value={sourceTraceUrl}
                    onChange={(event) => {
                      setSourceTraceUrl(event.target.value);
                      setSourceTraceError(null);
                    }}
                    placeholder="https://www.instagram.com/p/... or https://example.com/image.jpg"
                    disabled={sourceTraceLoading}
                    className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary disabled:opacity-60"
                  />
                  <button
                    type="submit"
                    disabled={sourceTraceLoading || !sourceTraceUrl.trim()}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-[13px] font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {sourceTraceLoading ? (
                      <><span className="animate-spin">◌</span> Searching public sources…</>
                    ) : (
                      <><Fingerprint className="size-4" /> Run source tracing</>
                    )}
                  </button>
                </form>

                {sourceTraceError ? (
                  <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {sourceTraceError}
                  </p>
                ) : null}

                {sourceTraceResult ? (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-md border border-border p-3">
                      <p className="text-sm font-medium">Source trace completed</p>
                      <p className="mt-1 break-all text-[11px] text-muted-foreground">
                        Submitted URL: {sourceTraceResult.submittedUrl ?? sourceTraceUrl}
                      </p>
                      {sourceTraceResult.sourceTracing?.warning ? (
                        <p className="mt-2 text-xs text-amber-600">
                          {sourceTraceResult.sourceTracing.warning}
                        </p>
                      ) : null}
                      <p className="mt-2 text-xs text-muted-foreground">
                        {discoveredSourceUrls.length} URL reference(s) found in the returned page/search data.
                      </p>
                    </div>

                    {discoveredSourceUrls.length > 0 ? (
                      <ul className="space-y-2">
                        {discoveredSourceUrls.slice(0, 30).map((url) => (
                          <li key={url} className="rounded-md border border-border p-3">
                            <a href={url} target="_blank" rel="noopener noreferrer" className="break-all text-xs text-primary hover:underline">
                              {url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No URL references were extracted from the response. The returned data may still contain page text or a search warning.
                      </p>
                    )}

                    <details className="rounded-md border border-border p-3">
                      <summary className="cursor-pointer text-xs font-medium">View raw TinyFish response</summary>
                      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
                        {JSON.stringify(sourceTraceResult.sourceTracing, null, 2)}
                      </pre>
                    </details>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {sourceTraceResult.disclaimer ?? "Search results are candidate indexed appearances, not proof of the true first upload."}
                    </p>
                  </div>
                ) : null}

                {sourceMatches.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    No verified public-source matches are attached to this investigation.
                  </p>
                ) : (
                  <div className="mt-3 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Stored source matches are shown below. They are not treated as proof of the original source.
                    </p>
                    <ul className="space-y-3">
                      {sourceMatches.map((m) => (
                        <li key={m.id} className="rounded-md border border-border p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="mono rounded-sm border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em]">Stored match</span>
                            <span className="text-sm">{m.source_name}</span>
                          </div>
                          {m.source_url ? (
                            <a href={m.source_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-[11px] text-primary hover:underline">
                              Open source reference
                            </a>
                          ) : null}
                          <p className="mono mt-1.5 text-[11px] text-muted-foreground">
                            similarity {m.similarity_score ?? "—"} · confidence {m.confidence ?? "—"} · recorded {m.discovered_date ?? "—"}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Panel>

              <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                Source Trace is evidence aggregation, not a claim of ownership or authorship. A missing metadata field, missing C2PA credential, or absence of a web match should not be interpreted alone as proof that the evidence is fake.
              </p>
            </div>
          ) : null}
        </div>

        {/* =====================================
            RIGHT SIDEBAR
           ===================================== */}

        <div className="space-y-4">
          <Panel title="Evidence item">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={`Evidence image for case ${inv.case_id}`}
                className="w-full rounded border border-border object-contain"
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No evidence preview is available for
                this record.
              </p>
            )}

            <div className="mono mt-3 flex items-start gap-2 break-all text-[11px] text-muted-foreground">
              <Fingerprint className="mt-0.5 size-3.5 shrink-0" />

              {evidence?.file_hash ??
                report?.fileHash ??
                "no fingerprint recorded"}
            </div>
          </Panel>

          <Panel title="Case record">
            <KeyValue
              items={[
                {
                  k: "Case ID",
                  v: inv.case_id,
                  mono: true,
                },
                {
                  k: "Investigator",
                  v:
                    inv.investigator_name ??
                    "—",
                },
                {
                  k: "Opened",
                  v: new Date(
                    inv.created_at,
                  ).toLocaleString(),
                  mono: true,
                },
                {
                  k: "Status",
                  v: inv.status ?? "—",
                  mono: true,
                },
                {
                  k: "Description",
                  v:
                    inv.evidence_description ??
                    "—",
                },
                {
                  k: "Verification",
                  v: "Full Verification",
                },
              ]}
            />
          </Panel>

          <Disclaimer />
        </div>
      </div>
    </PageShell>
  );
}

/* ================================================
   SIGNAL LIST
   ================================================ */

function SignalList({
  signals,
}: {
  signals: StoredSignal[];
}) {
  return (
    <ul className="divide-y divide-border">
      {signals.map((s) => (
        <li
          key={s.key}
          className="flex items-start gap-3 py-2.5"
        >
          <span className="mt-0.5">
            <SignalIcon status={s.status} />
          </span>

          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-medium">
                {s.label}
              </span>

              <span className="mono text-[11px] text-muted-foreground">
                {s.value}
              </span>
            </div>

            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {s.detail}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ================================================
   SCOPE CHECKLIST
   ================================================ */

function ScopeChecklist({
  title,
  signals,
}: {
  title: string;
  signals: StoredSignal[];
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <h3 className="mono text-[11px] font-semibold uppercase tracking-[0.14em]">
        {title}
      </h3>

      <ul className="mt-2 space-y-1.5">
        {signals.map((s) => (
          <li
            key={s.key}
            className="flex items-start gap-2 text-xs"
          >
            <span
              className="mono mt-0.5"
              style={{
                color:
                  s.status === "supportive"
                    ? "var(--ok)"
                    : s.status ===
                        "inconsistent"
                      ? "var(--warn)"
                      : "var(--muted-foreground)",
              }}
            >
              {s.status === "supportive"
                ? "✓"
                : s.status === "inconsistent"
                  ? "⚠"
                  : "—"}
            </span>

            <span>
              {s.label}:{" "}
              <span className="text-muted-foreground">
                {s.value}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ================================================
   SCORE TRACE
   ================================================ */

function ScoreTrace({
  report,
}: {
  report: {
    signalBreakdown: {
      signal: string;
      weight: number;
      normalized: number;
      contribution: number;
      scope: string;
    }[];
  };
}) {
  return (
    <details className="mt-4 rounded-md border border-border">
      <summary className="mono cursor-pointer px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        Score trace — weighted signal
        contributions
      </summary>

      <div className="overflow-x-auto px-3 pb-3">
        <table className="w-full min-w-[520px] text-left text-xs">
          <thead className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <tr>
              <th className="py-1.5 pr-3 font-medium">
                Signal
              </th>

              <th className="py-1.5 pr-3 font-medium">
                Scope
              </th>

              <th className="py-1.5 pr-3 font-medium">
                Weight
              </th>

              <th className="py-1.5 pr-3 font-medium">
                Normalised
              </th>

              <th className="py-1.5 font-medium">
                Points
              </th>
            </tr>
          </thead>

          <tbody>
            {report.signalBreakdown.map(
              (b) => (
                <tr
                  key={`${b.scope}-${b.signal}`}
                  className="border-t border-border/60"
                >
                  <td className="py-1.5 pr-3">
                    {b.signal}
                  </td>

                  <td className="mono py-1.5 pr-3 uppercase">
                    {b.scope}
                  </td>

                  <td className="mono py-1.5 pr-3">
                    {b.weight}
                  </td>

                  <td className="mono py-1.5 pr-3">
                    {b.normalized}
                  </td>

                  <td className="mono py-1.5">
                    {b.contribution}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/* ================================================
   FINDING
   ================================================ */

const SEVERITY_COLOR: Record<
  string,
  string
> = {
  INFORMATIONAL: "var(--primary)",
  LOW: "var(--ok)",
  MODERATE: "var(--warn)",
  HIGH: "var(--high)",
};

export function FindingItem({
  finding,
}: {
  finding: StoredFinding;
}) {
  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="mono rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em]"
          style={{
            color:
              SEVERITY_COLOR[
                finding.severity
              ],
            borderColor:
              SEVERITY_COLOR[
                finding.severity
              ],
          }}
        >
          {finding.severity}
        </span>

        <span className="text-sm font-medium">
          {finding.title}
        </span>

        <span className="mono ml-auto text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          confidence{" "}
          {finding.confidence} ·{" "}
          {finding.signalType}
        </span>
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {finding.explanation}
      </p>
    </li>
  );
}

/* ================================================
   WHY THIS RESULT
   ================================================ */

function WhyThisResult({
  report,
}: {
  report: StoredReport;
}) {
  const contributors = [
    ...report.signalBreakdown,
  ]
    .filter(
      (b) => b.contribution > 0,
    )
    .sort(
      (a, b) =>
        b.contribution -
        a.contribution,
    )
    .slice(0, 6);

  const unavailable = report.signals
    .filter(
      (s) => s.status === "unavailable",
    )
    .slice(0, 4);

  const supportive = report.signals
    .filter(
      (s) => s.status === "supportive",
    )
    .slice(0, 4);

  const regional = report.regional;

  return (
    <details
      className="panel rounded-md"
      open
    >
      <summary className="mono cursor-pointer px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Why this result?
      </summary>

      <div className="space-y-4 px-4 pb-4">
        <ul className="space-y-1.5">
          {supportive.map((s) => (
            <li
              key={`s-${s.key}`}
              className="flex items-start gap-2 text-xs"
            >
              <span
                className="mono"
                style={{
                  color: "var(--ok)",
                }}
              >
                +
              </span>

              <span>
                {s.label}{" "}
                <span className="text-muted-foreground">
                  — {s.value}
                </span>
              </span>
            </li>
          ))}

          {contributors.map((b) => (
            <li
              key={`c-${b.scope}-${b.signal}`}
              className="flex items-start gap-2 text-xs"
            >
              <span
                className="mono"
                style={{
                  color: "var(--warn)",
                }}
              >
                +
              </span>

              <span>
                {b.signal} raised the{" "}
                {b.scope === "ai"
                  ? "AI-generation"
                  : "manipulation"}{" "}
                score by{" "}
                <span className="mono">
                  {b.contribution}
                </span>{" "}
                of {b.weight} available
                points
              </span>
            </li>
          ))}

          {unavailable.map((s) => (
            <li
              key={`u-${s.key}`}
              className="flex items-start gap-2 text-xs"
            >
              <span className="mono text-muted-foreground">
                −
              </span>

              <span className="text-muted-foreground">
                {s.label} could not be
                measured — {s.detail}
              </span>
            </li>
          ))}

          {regional?.available ? (
            <li className="flex items-start gap-2 text-xs">
              <span
                className="mono"
                style={{
                  color:
                    regional.strongTileRatio >
                    0.1
                      ? "var(--warn)"
                      : "var(--ok)",
                }}
              >
                {regional.strongTileRatio >
                0.1
                  ? "+"
                  : "−"}
              </span>

              <span>
                {regional.strongTileRatio >
                0.1
                  ? `${Math.round(
                      regional.strongTileRatio *
                        100,
                    )}% of image tiles deviate strongly from this image's own baseline`
                  : "No strong regional anomalies detected across the tile grid"}
              </span>
            </li>
          ) : null}
        </ul>

        <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          How these combined: AI-generation
          likelihood and manipulation likelihood
          are scored independently — neither is
          derived from the other — by summing the
          weighted contributions above over the
          points that were actually measurable (
          {report.availableSignalCount} signal
          families available). Authenticity
          confidence (
          {report.authenticityConfidence}
          /100) reflects how much evidence was
          available and how well the signals agree:{" "}
          {report.confidenceReason}
          {report.confidenceStatus ===
          "INSUFFICIENT_EVIDENCE"
            ? " Because too little was measurable, this case is reported as insufficient evidence rather than as a percentage judgement."
            : ""}
        </p>
      </div>
    </details>
  );
}
