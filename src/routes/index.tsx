import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { FilePlus2, FolderOpen, FileText, ShieldAlert } from "lucide-react";
import { fetchInvestigations, type Investigation, bandLabel } from "@/lib/sachscan";
import { DemoBadge, Disclaimer, MetricCard, PageShell, Panel, RiskBadge, StatusChip } from "@/components/forensic/ui";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SACHSCAN Dashboard — Digital Media Forensics & Verification" },
      {
        name: "description",
        content:
          "Forensic case dashboard: open investigations, high-risk cases and recent image evidence assessments in SACHSCAN.",
      },
      { property: "og:title", content: "SACHSCAN Dashboard — Digital Media Forensics" },
      {
        property: "og:description",
        content: "Verify the evidence. Understand the media. Case dashboard for image forensic investigations.",
      },
    ],
  }),
  component: Dashboard,
});

function btn(variant: "primary" | "ghost" = "ghost") {
  return variant === "primary"
    ? "inline-flex items-center gap-2 rounded-md bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
    : "inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3.5 py-2 text-[13px] font-medium transition-colors hover:bg-accent";
}

function Dashboard() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["investigations"],
    queryFn: fetchInvestigations,
  });

  const rows = data ?? [];
  const total = rows.length;
  const active = rows.filter((r) => r.status !== "complete").length;
  const highRisk = rows.filter((r) => ["HIGH", "CRITICAL"].includes((r.risk_level ?? "").toUpperCase())).length;
  const weekAgo = Date.now() - 7 * 864e5;
  const recent = rows.filter((r) => new Date(r.created_at).getTime() > weekAgo).length;

  return (
    <PageShell
      title="SACHSCAN"
      subtitle="Digital Media Forensics & Verification — verify the evidence, understand the media."
      actions={
        <>
          <Link to="/investigations/new" className={btn("primary")}>
            <FilePlus2 className="size-4" /> New Investigation
          </Link>
          <Link to="/investigations" className={btn()}>
            <FolderOpen className="size-4" /> View Investigations
          </Link>
          <Link to="/investigations" search={{ view: "reports" }} className={btn()}>
            <FileText className="size-4" /> Reports
          </Link>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Total investigations" value={isLoading ? "…" : total} />
        <MetricCard label="Active investigations" value={isLoading ? "…" : active} sub="Not yet completed" />
        <MetricCard
          label="High-risk cases"
          value={isLoading ? "…" : highRisk}
          sub="HIGH or CRITICAL banding"
          color="var(--high)"
        />
        <MetricCard label="Recent (7 days)" value={isLoading ? "…" : recent} />
      </div>

      <div className="mt-6 grid gap-4">
        <Panel title="Recent investigations">
          {error ? (
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="text-destructive">Case records could not be loaded: {(error as Error).message}</span>
              <button className={btn()} onClick={() => refetch()}>
                Retry
              </button>
            </div>
          ) : isLoading ? (
            <p className="text-sm text-muted-foreground">Loading case records…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No investigations on record. Open a new investigation to begin evidence intake.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.slice(0, 6).map((r) => (
                <CaseRow key={r.id} row={r} />
              ))}
            </ul>
          )}
        </Panel>

        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <Disclaimer />
          <div className="panel rounded-md px-4 py-3 text-xs text-muted-foreground">
            <ShieldAlert className="mb-1.5 size-3.5" style={{ color: "var(--warn)" }} />
            Automated web-wide source verification is not available in this prototype.
          </div>
        </div>
      </div>
    </PageShell>
  );
}

function CaseRow({ row }: { row: Investigation }) {
  const demo = Boolean(row.is_demo);
  return (
    <li>
      <Link
        to="/investigations/$id"
        params={{ id: row.id }}
        className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 py-3 transition-colors hover:bg-accent/50 ${
          demo ? "border-l-2 border-dashed pl-3" : "border-l-2 border-solid pl-3"
        }`}
        style={demo ? { borderColor: "var(--demo)" } : { borderColor: "var(--primary)" }}
      >
        <span className="mono text-[13px] font-semibold">{row.case_id}</span>
        {demo ? <DemoBadge /> : null}
        <span className="text-[13px] text-muted-foreground">{row.evidence_name ?? "No evidence attached"}</span>
        <span className="ml-auto flex items-center gap-3">
          <span className="mono text-[11px] text-muted-foreground">
            AI {row.ai_probability ?? "—"} · MANIP {row.manipulation_probability ?? "—"} ·{" "}
            {bandLabel(row.ai_probability)}
          </span>
          <StatusChip status={row.status} />
          <RiskBadge risk={row.risk_level} />
        </span>
      </Link>
    </li>
  );
}
