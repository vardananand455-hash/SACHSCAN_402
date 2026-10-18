import type { ReactNode } from "react";
import { AlertTriangle, Check, Minus, Info } from "lucide-react";
import { DISCLAIMER, RISK_WORDING, riskColorVar, scoreColorVar } from "@/lib/sachscan";
import { cn } from "@/lib/utils";

export function PageShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-[1400px] px-5 py-8">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <h1 className="mono text-xl font-semibold tracking-[0.14em] uppercase">{title}</h1>
          {subtitle ? <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </main>
  );
}

export function Panel({
  title,
  right,
  className,
  children,
}: {
  title?: string;
  right?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("panel print-plain rounded-md", className)}>
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <h2 className="mono text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</h2>
          {right}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function DemoBadge() {
  return (
    <span
      className="mono inline-flex items-center rounded-sm border border-dashed px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
      style={{ color: "var(--demo)", borderColor: "var(--demo)" }}
    >
      Demo case
    </span>
  );
}

export function SimulatedBadge() {
  return (
    <span
      className="mono inline-flex items-center rounded-sm border border-dashed px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
      style={{ color: "var(--demo)", borderColor: "var(--demo)" }}
    >
      Demo / simulated source match
    </span>
  );
}

export function HeuristicTag() {
  return (
    <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
      Heuristic analysis, not a trained classifier
    </span>
  );
}

export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  const value = (risk ?? "UNKNOWN").toUpperCase();
  return (
    <span
      className="mono inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
      style={{ color: riskColorVar(value), borderColor: riskColorVar(value) }}
      title={RISK_WORDING[value] ?? "Risk banding unavailable"}
    >
      {value}
    </span>
  );
}

export function StatusChip({ status }: { status: string | null | undefined }) {
  const v = (status ?? "unknown").toLowerCase();
  return (
    <span className="mono rounded-sm border border-border bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
      {v}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  color?: string;
}) {
  return (
    <div className="panel print-plain rounded-md p-4">
      <div className="mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mono mt-2 text-2xl font-semibold" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export function ScoreRing({
  value,
  label,
  caption,
  color,
}: {
  value: number | null;
  label: string;
  caption?: string;
  color?: string;
}) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  const stroke = color ?? scoreColorVar(value);
  const r = 46;
  const c = 2 * Math.PI * r;
  return (
    <div className="panel print-plain flex flex-col items-center rounded-md p-4">
      <svg viewBox="0 0 120 120" className="size-28">
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--border)" strokeWidth="8" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          transform="rotate(-90 60 60)"
          style={{ transition: "stroke-dasharray 700ms ease" }}
        />
        <text
          x="60"
          y="58"
          textAnchor="middle"
          fill="currentColor"
          style={{ fontFamily: "var(--font-mono)", fontSize: 24, fontWeight: 600 }}
        >
          {value === null ? "—" : value}
        </text>
        <text
          x="60"
          y="76"
          textAnchor="middle"
          fill="var(--muted-foreground)"
          style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 1 }}
        >
          /100
        </text>
      </svg>
      <div className="mono mt-2 text-center text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      {caption ? <div className="mt-1 text-center text-xs">{caption}</div> : null}
    </div>
  );
}

export function SignalIcon({ status }: { status: string }) {
  if (status === "supportive") return <Check className="size-3.5" style={{ color: "var(--ok)" }} />;
  if (status === "inconsistent") return <AlertTriangle className="size-3.5" style={{ color: "var(--warn)" }} />;
  return <Minus className="size-3.5 text-muted-foreground" />;
}

export function Disclaimer() {
  return (
    <div className="panel print-plain flex items-start gap-2.5 rounded-md px-4 py-3 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" style={{ color: "var(--primary)" }} />
      <span>{DISCLAIMER}</span>
    </div>
  );
}

export function KeyValue({ items }: { items: { k: string; v: ReactNode; mono?: boolean }[] }) {
  return (
    <dl className="divide-y divide-border">
      {items.map((item) => (
        <div key={item.k} className="flex items-start justify-between gap-6 py-2 text-sm">
          <dt className="text-muted-foreground">{item.k}</dt>
          <dd className={cn("max-w-[62%] break-words text-right", item.mono && "mono text-[12px]")}>{item.v}</dd>
        </div>
      ))}
    </dl>
  );
}
