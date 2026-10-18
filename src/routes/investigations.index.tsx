import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchInvestigations } from "@/lib/sachscan";
import { DemoBadge, PageShell, Panel, RiskBadge, StatusChip } from "@/components/forensic/ui";

export const Route = createFileRoute("/investigations/")({
  head: () => ({
    meta: [
      { title: "Case History — SACHSCAN Forensic Investigations" },
      {
        name: "description",
        content:
          "Complete case history of SACHSCAN forensic investigations with risk banding, AI-generation and manipulation likelihood per evidence item.",
      },
      { property: "og:title", content: "Case History — SACHSCAN" },
      { property: "og:description", content: "All recorded forensic investigations and their assessment outcomes." },
    ],
  }),
  component: CaseHistory,
});

function CaseHistory() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["investigations"],
    queryFn: fetchInvestigations,
  });
  const rows = data ?? [];

  return (
    <PageShell
      title="Case history"
      subtitle="All investigations on record, read directly from the case database."
      actions={
        <Link
          to="/investigations/new"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          New Investigation
        </Link>
      }
    >
      <Panel>
        {error ? (
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-destructive">Failed to load case records: {(error as Error).message}</span>
            <button
              className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[13px]"
              onClick={() => refetch()}
            >
              Retry
            </button>
          </div>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading case records…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No investigations on record.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-[13px]">
              <thead>
                <tr className="mono border-b border-border text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Case ID</th>
                  <th className="py-2 pr-3 font-medium">Evidence</th>
                  <th className="py-2 pr-3 font-medium">Investigator</th>
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Risk</th>
                  <th className="py-2 pr-3 font-medium">AI</th>
                  <th className="py-2 pr-3 font-medium">Manip.</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border/70 last:border-0 hover:bg-accent/40"
                    style={
                      r.is_demo
                        ? { borderLeft: "2px dashed var(--demo)" }
                        : { borderLeft: "2px solid var(--primary)" }
                    }
                  >
                    <td className="py-2.5 pl-3 pr-3">
                      <Link to="/investigations/$id" params={{ id: r.id }} className="mono font-semibold hover:underline">
                        {r.case_id}
                      </Link>
                      {r.is_demo ? (
                        <span className="ml-2 align-middle">
                          <DemoBadge />
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground">{r.evidence_name ?? "—"}</td>
                    <td className="py-2.5 pr-3 text-muted-foreground">{r.investigator_name ?? "—"}</td>
                    <td className="mono py-2.5 pr-3 text-[12px] text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="py-2.5 pr-3">
                      <RiskBadge risk={r.risk_level} />
                    </td>
                    <td className="mono py-2.5 pr-3">{r.ai_probability ?? "—"}</td>
                    <td className="mono py-2.5 pr-3">{r.manipulation_probability ?? "—"}</td>
                    <td className="py-2.5 pr-3">
                      <StatusChip status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="mt-3 text-xs text-muted-foreground">
        Rows with a dashed amber marker and a DEMO CASE chip are reference records, not live analyses.
      </p>
    </PageShell>
  );
}
