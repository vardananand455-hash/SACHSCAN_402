/**
 * SACHSCAN identity.
 *
 * The mark is a forensic reticle: a precision-instrument aperture built from a
 * hexagonal frame, four corner brackets (evidence-crop markers), a crosshair
 * with a deliberate centre gap, and a single scan line crossing the aperture.
 * It is drawn entirely from geometry on a 32-unit grid so it stays sharp at
 * favicon sizes, and it inherits colour from the surrounding text.
 */
export function SachscanMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden="true">
      {/* hexagonal instrument frame */}
      <path
        d="M16 1.6 27.5 8.3v15.4L16 30.4 4.5 23.7V8.3Z"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* aperture */}
      <circle cx="16" cy="16" r="7.1" stroke="currentColor" strokeOpacity="0.9" strokeWidth="1.3" />
      <circle cx="16" cy="16" r="3.1" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1" />
      {/* crosshair with centre gap */}
      <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <path d="M16 5.6v4.2M16 22.2v4.2M5.6 16h4.2M22.2 16h4.2" strokeOpacity="0.8" />
      </g>
      {/* evidence-crop corner brackets */}
      <g stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.1" strokeLinecap="square">
        <path d="M9.4 7.2H7.2v2.2M22.6 7.2h2.2v2.2M9.4 24.8H7.2v-2.2M22.6 24.8h2.2v-2.2" />
      </g>
      {/* scan line */}
      <path d="M8.9 16h14.2" stroke="currentColor" strokeWidth="1.4" strokeOpacity="0.95" strokeLinecap="round" />
      <circle cx="16" cy="16" r="1.15" fill="currentColor" />
    </svg>
  );
}

/** Full lockup: mark plus technical wordmark and descriptor. */
export function SachscanLockup() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-8 items-center justify-center rounded-[5px] border border-primary/35 bg-primary/[0.07] text-primary shadow-[inset_0_0_12px_-6px_currentColor]">
        <SachscanMark className="size-[22px]" />
      </span>
      <span className="flex flex-col leading-none">
        <span className="mono text-[13px] font-semibold uppercase tracking-[0.3em] text-foreground">
          Sachscan
        </span>
        <span className="mono mt-1 text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
          Digital Media Forensics
        </span>
      </span>
    </span>
  );
}
