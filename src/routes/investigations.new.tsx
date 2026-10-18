
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { generateCaseId } from "@/lib/sachscan";
import { Disclaimer, PageShell, Panel } from "@/components/forensic/ui";

export const Route = createFileRoute("/investigations/new")({
  head: () => ({
    meta: [
      { title: "New Investigation — SACHSCAN Case Intake" },
      {
        name: "description",
        content:
          "Open a new SACHSCAN forensic investigation: record the case ID, investigator and evidence description.",
      },
      { property: "og:title", content: "New Investigation — SACHSCAN" },
      {
        property: "og:description",
        content: "Case intake for digital media forensic examination.",
      },
    ],
  }),
  component: NewInvestigation,
});

function NewInvestigation() {
  const navigate = useNavigate();
  const [caseId, setCaseId] = useState("");
  const [investigator, setInvestigator] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const id = caseId.trim() || generateCaseId();

    const { data, error: insertError } = await supabase
      .from("investigations")
      .insert({
        case_id: id,
        investigator_name: investigator.trim() || null,
        evidence_description: description.trim() || null,
        status: "draft",
        is_demo: false,
      })
      .select("id")
      .single();

    setBusy(false);

    if (insertError || !data) {
      setError(
        insertError?.message ??
          "The investigation record could not be created.",
      );
      return;
    }

    toast.success(`Investigation ${id} opened`);

    navigate({
      to: "/investigations/$id/upload",
      params: { id: data.id },
    });
  }

  const field =
    "mt-1.5 w-full rounded-md border border-input bg-surface-2 px-3 py-2 text-sm outline-none transition-colors focus:border-primary";

  return (
    <PageShell
      title="New investigation"
      subtitle="Case intake — step 1 of 3"
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel title="Case information">
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label
                className="mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                htmlFor="caseId"
              >
                Case ID (optional)
              </label>
              <input
                id="caseId"
                value={caseId}
                maxLength={64}
                onChange={(e) => setCaseId(e.target.value)}
                placeholder="Leave blank to auto-generate (SS-YYYYMMDD-XXXX)"
                className={`${field} mono`}
              />
            </div>

            <div>
              <label
                className="mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                htmlFor="inv"
              >
                Investigator name
              </label>
              <input
                id="inv"
                value={investigator}
                maxLength={120}
                onChange={(e) => setInvestigator(e.target.value)}
                placeholder="Name of the examining analyst"
                className={field}
              />
            </div>

            <div>
              <label
                className="mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                htmlFor="desc"
              >
                Evidence description
              </label>
              <textarea
                id="desc"
                value={description}
                maxLength={2000}
                rows={5}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Provenance of the item, how it was received, and the question the examination must answer."
                className={field}
              />
            </div>

            {error ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
              >
                {busy ? "Creating case record…" : "Continue to Evidence"}
              </button>
              <span className="text-xs text-muted-foreground">
                A case record is written before evidence intake.
              </span>
            </div>
          </form>
        </Panel>

        <div className="space-y-4">
          <Panel title="Chain of custody">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Each investigation is stored with its case ID, examiner and
              timestamp before any evidence is ingested. Evidence files are
              fingerprinted with SHA-256 on ingestion so that repeat
              examination of the same item always returns the same assessment.
            </p>
          </Panel>
          <Disclaimer />
        </div>
      </div>
    </PageShell>
  );
}
