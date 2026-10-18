import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Printer, ArrowLeft } from "lucide-react";

import {
  DISCLAIMER,
  fetchCaseBundle,
  formatBytes,
  RISK_WORDING,
  bandLabel,
} from "@/lib/sachscan";

import { asReport } from "@/lib/forensic-report";

import {
  DemoBadge,
  KeyValue,
  PageShell,
  Panel,
} from "@/components/forensic/ui";

export const Route = createFileRoute("/investigations/$id/report")({
  head: () => ({
    meta: [
      { title: "Forensic Assessment Report — SACHSCAN" },
      {
        name: "description",
        content:
          "Printable SACHSCAN digital media forensic assessment report: executive summary, assessments, metadata, findings, provenance and limitations.",
      },
      {
        property: "og:title",
        content: "Forensic Assessment Report — SACHSCAN",
      },
      {
        property: "og:description",
        content:
          "Full forensic assessment report for an image evidence item.",
      },
    ],
  }),

  component: Report,
});

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5">
      <h2 className="mono border-b border-border pb-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </h2>

      <div className="mt-3 text-sm leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function Report() {
  const { id } = Route.useParams();

  const {
    data,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["case", id],
    queryFn: () => fetchCaseBundle(id),
  });

  if (isLoading) {
    return (
      <PageShell
        title="Report"
        subtitle="Preparing assessment report…"
      >
        <Panel>
          <p className="text-sm text-muted-foreground">
            Compiling the report from stored case data…
          </p>
        </Panel>
      </PageShell>
    );
  }

  if (error || !data) {
    return (
      <PageShell
        title="Report"
        subtitle="Report unavailable"
      >
        <Panel>
          <p className="text-sm text-destructive">
            {(error as Error)?.message ??
              "Report data could not be loaded."}
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
  } = data;

  const report = asReport(analysis?.signals);

  return (
    <PageShell
      title="SACHSCAN — Digital Media Forensic Assessment"
      subtitle={`Case ${inv.case_id}`}
      actions={
        <>
          {inv.is_demo ? <DemoBadge /> : null}

          <Link
            to="/investigations/$id"
            params={{ id }}
            className="no-print inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3.5 py-2 text-[13px] hover:bg-accent"
          >
            <ArrowLeft className="size-4" />
            Assessment
          </Link>

          <button
            onClick={() => window.print()}
            className="no-print inline-flex items-center gap-2 rounded-md bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Printer className="size-4" />
            Print / Save as PDF
          </button>
        </>
      }
    >
      <article className="panel print-plain rounded-md p-6">
        {/* -------------------------------------------------- */}
        {/* HEADER */}
        {/* -------------------------------------------------- */}

        <header className="border-b border-border pb-4">
          <h1 className="mono text-base font-semibold tracking-[0.14em] uppercase">
            SACHSCAN — Digital Media Forensic Assessment
          </h1>

          <p className="mt-1 text-xs text-muted-foreground">
            Verify the evidence. Understand the media.
          </p>

          <div className="mt-4">
            <KeyValue
              items={[
                {
                  k: "Case ID",
                  v: inv.case_id,
                  mono: true,
                },
                {
                  k: "Investigator",
                  v: inv.investigator_name ?? "Unattributed",
                },
                {
                  k: "Evidence item",
                  v:
                    inv.evidence_name ??
                    evidence?.file_name ??
                    "—",
                  mono: true,
                },
                {
                  k: "Report date",
                  v: new Date().toLocaleString(),
                  mono: true,
                },
                {
                  k: "Case status",
                  v: inv.status ?? "—",
                  mono: true,
                },
                {
                  k: "Record type",
                  v: inv.is_demo
                    ? "DEMO CASE (pre-written reference record)"
                    : "Live analysis",
                },
              ]}
            />
          </div>
        </header>

        {/* -------------------------------------------------- */}
        {/* EXECUTIVE SUMMARY */}
        {/* -------------------------------------------------- */}

        <Section title="Executive summary">
          <p>
            {inv.summary ??
              "No assessment summary is stored for this case."}
          </p>
        </Section>

        {/* -------------------------------------------------- */}
        {/* OVERALL ASSESSMENT */}
        {/* -------------------------------------------------- */}

        <Section title="Overall assessment">
          <KeyValue
            items={[
              {
                k: "Overall risk banding",
                v: `${inv.risk_level ?? "—"} — ${
                  RISK_WORDING[
                    (inv.risk_level ?? "").toUpperCase()
                  ] ?? "unavailable"
                }`,
              },
              {
                k: "AI generation likelihood",
                v: `${inv.ai_probability ?? "—"} / 100 (${bandLabel(
                  inv.ai_probability,
                )})`,
                mono: true,
              },
              {
                k: "Manipulation likelihood",
                v: `${inv.manipulation_probability ?? "—"} / 100 (${bandLabel(
                  inv.manipulation_probability,
                )})`,
                mono: true,
              },
              {
                k: "Authenticity confidence",
                v: `${inv.authenticity_confidence ?? "—"} / 100${
                  report?.confidenceStatus ===
                  "INSUFFICIENT_EVIDENCE"
                    ? " (Insufficient evidence)"
                    : ""
                }`,
                mono: true,
              },
            ]}
          />

          <p className="mt-2 text-xs text-muted-foreground">
            Heuristic analysis, not a trained classifier. Risk
            banding of CRITICAL denotes a high concentration of
            suspicious indicators, never a confirmed determination
            that an item is fake.
          </p>
        </Section>

        {/* -------------------------------------------------- */}
        {/* AI GENERATION */}
        {/* -------------------------------------------------- */}

        <Section title="AI generation assessment">
          {report ? (
            <ul className="space-y-1.5">
              {report.signals
                .filter((s) =>
                  [
                    "software",
                    "dimensions",
                    "noise",
                    "luminance",
                    "c2pa",
                  ].includes(s.key),
                )
                .map((s) => (
                  <li
                    key={s.key}
                    className="text-sm"
                  >
                    <span className="mono mr-2">
                      {s.status === "supportive"
                        ? "✓"
                        : s.status === "inconsistent"
                          ? "⚠"
                          : "—"}
                    </span>

                    {s.label}:{" "}
                    <span className="text-muted-foreground">
                      {s.value}
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              Signal-level detail is not stored for this record.
            </p>
          )}
        </Section>

        {/* -------------------------------------------------- */}
        {/* MANIPULATION */}
        {/* -------------------------------------------------- */}

        <Section title="Manipulation assessment">
          {report ? (
            <ul className="space-y-1.5">
              {report.signals
                .filter((s) =>
                  [
                    "quantization",
                    "chroma",
                    "camera",
                    "format",
                  ].includes(s.key),
                )
                .map((s) => (
                  <li
                    key={s.key}
                    className="text-sm"
                  >
                    <span className="mono mr-2">
                      {s.status === "supportive"
                        ? "✓"
                        : s.status === "inconsistent"
                          ? "⚠"
                          : "—"}
                    </span>

                    {s.label}:{" "}
                    <span className="text-muted-foreground">
                      {s.value}
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              Signal-level detail is not stored for this record.
            </p>
          )}
        </Section>

        {/* -------------------------------------------------- */}
        {/* AUTHENTICITY CONFIDENCE */}
        {/* -------------------------------------------------- */}

        <Section title="Authenticity confidence">
          <p>
            {report?.confidenceReason ??
              "Confidence rationale is not stored for this record."}
          </p>
        </Section>

        {/* -------------------------------------------------- */}
        {/* METADATA */}
        {/* -------------------------------------------------- */}

        <Section title="Metadata findings">
          <KeyValue
            items={[
              {
                k: "Metadata status",
                v: (
                  report?.metadataStatus ??
                  inv.metadata_status ??
                  "UNKNOWN"
                ).replace("_", " "),
                mono: true,
              },
              {
                k: "File name",
                v: evidence?.file_name ?? "—",
                mono: true,
              },
              {
                k: "Verified format",
                v: report?.file.detectedFormat ?? "—",
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
                v: evidence?.width
                  ? `${evidence.width} × ${evidence.height}`
                  : report?.file.width
                    ? `${report.file.width} × ${report.file.height}`
                    : "—",
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
              {
                k: "Camera",
                v: `${report?.exif?.["Make"] ?? "—"} ${
                  report?.exif?.["Model"] ?? ""
                }`.trim(),
                mono: true,
              },
              {
                k: "Capture time",
                v: String(
                  report?.exif?.["DateTimeOriginal"] ??
                    "Not present",
                ),
                mono: true,
              },
              {
                k: "Software",
                v: String(
                  report?.exif?.["Software"] ??
                    "Not present",
                ),
                mono: true,
              },
            ]}
          />

          <p className="mt-2 text-xs text-muted-foreground">
            {report?.metadataStatusReason ?? ""}
          </p>
        </Section>

        {/* -------------------------------------------------- */}
        {/* FINDINGS */}
        {/* -------------------------------------------------- */}

        <Section title="Forensic findings">
          {report && report.findings.length > 0 ? (
            <ol className="space-y-3">
              {report.findings.map((f, i) => (
                <li key={f.id}>
                  <p className="text-sm font-medium">
                    {i + 1}. {f.title}{" "}
                    <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      [{f.severity} · confidence{" "}
                      {f.confidence} · {f.signalType}]
                    </span>
                  </p>

                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {f.explanation}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground">
              No structured findings are stored for this record.
            </p>
          )}
        </Section>

        {/* -------------------------------------------------- */}
        {/* REGIONAL FORENSIC ANALYSIS */}
        {/* -------------------------------------------------- */}

        <Section title="Regional forensic analysis">
          {report?.regional?.available ? (
            <>
              <p>
                {report.regional.summary}
              </p>

              <KeyValue
                items={[
                  {
                    k: "Tile grid",
                    v: `${report.regional.cols} × ${report.regional.rows}`,
                    mono: true,
                  },

                  /*
                   * IMPORTANT:
                   *
                   * Your project uses StoredRegionalMap.
                   * That type contains peakIntensity.
                   *
                   * Do NOT use maxScore here.
                   *
                   * Also do NOT use:
                   *
                   * report.regional.peakIntensity.toFixed(3)
                   *
                   * because peakIntensity can be undefined.
                   *
                   * The fallback prevents:
                   *
                   * Cannot read properties of undefined
                   * (reading 'toFixed')
                   */
                  {
                    k: "Peak regional intensity",
                    v: `${report.regional?.peakIntensity ?? 0}`,
                    mono: true,
                  },

                  {
                    k: "Tiles above strong-signal threshold",
                    v: `${Math.round(
                      (report.regional.strongTileRatio ?? 0) *
                        100,
                    )}%`,
                    mono: true,
                  },

                  {
                    k: "Baseline local noise",
                    v:
                      report.regional.baseline?.noise ??
                      "—",
                    mono: true,
                  },

                  {
                    k: "Baseline local texture σ",
                    v:
                      report.regional.baseline?.texture ??
                      "—",
                    mono: true,
                  },

                  {
                    k: "Baseline local edge energy",
                    v:
                      report.regional.baseline?.edge ??
                      "—",
                    mono: true,
                  },
                ]}
              />

              <p className="mt-2 text-xs text-muted-foreground">
                Highlighted regions represent areas with stronger
                detected forensic signals. This visualization is
                indicative and does not independently prove AI
                generation or manipulation.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">
              {report?.regional?.reason ??
                "No regional tile analysis is stored for this record."}
            </p>
          )}
        </Section>

        {/* -------------------------------------------------- */}
        {/* PROVENANCE */}
        {/* -------------------------------------------------- */}

        <Section title="Provenance findings">
          <p>
            Automated web-wide source verification is not available
            in this prototype. Provenance assessment is limited to
            metadata origin clues, software lineage, the file
            fingerprint and C2PA content credentials where present.
          </p>

          <KeyValue
            items={[
              {
                k: "C2PA content credentials",
                v: report?.c2paPresent
                  ? "Present"
                  : "Not detected",
                mono: true,
              },
              {
                k: "Geolocation tags",
                v: report?.exif?.["GPSPresent"]
                  ? "Present (coordinates withheld)"
                  : "Not present",
                mono: true,
              },
              {
                k: "Source trace status",
                v:
                  inv.source_trace_status ??
                  "NOT_AVAILABLE",
                mono: true,
              },
            ]}
          />
        </Section>

        {/* -------------------------------------------------- */}
        {/* TECHNICAL SIGNALS */}
        {/* -------------------------------------------------- */}

        <Section title="Technical signals">
          {report ? (
            <div className="overflow-x-auto">
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
                  {report.signalBreakdown.map((b) => (
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
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Technical signal breakdown is not stored for this
              record.
            </p>
          )}
        </Section>

        {/* -------------------------------------------------- */}
        {/* LIMITATIONS */}
        {/* -------------------------------------------------- */}

        <Section title="Limitations">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              This engine is a transparent heuristic system, not a
              scientifically validated classifier.
            </li>

            <li>
              Absent metadata is common and legitimate; it is never
              treated as evidence of manipulation or synthesis.
            </li>

            <li>
              Pixel-level statistics are sampled on a fixed grid and
              are unavailable for formats this build cannot decode.
            </li>

            <li>
              Automated reverse-image and web-wide source
              verification are not implemented in this prototype.
            </li>

            <li>
              Editing software signatures indicate processing,
              which is frequently legitimate, not content
              falsification.
            </li>
          </ul>
        </Section>

        {/* -------------------------------------------------- */}
        {/* DISCLAIMER */}
        {/* -------------------------------------------------- */}

        <Section title="Disclaimer">
          <p className="text-sm text-muted-foreground">
            {DISCLAIMER} SACHSCAN reports forensic signals and their
            weighted contributions so that an examiner can reach an
            informed conclusion; it does not certify authenticity,
            and it must not be presented as a definitive
            determination in any proceeding.
          </p>
        </Section>
      </article>
    </PageShell>
  );
}