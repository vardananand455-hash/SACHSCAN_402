import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Lock } from "lucide-react";

import { fetchCaseBundle } from "@/lib/sachscan";
import { asReport } from "@/lib/forensic-report";
import {
  Disclaimer,
  KeyValue,
  PageShell,
  Panel,
} from "@/components/forensic/ui";

export const Route = createFileRoute("/investigations/$id/heatmap")({
  head: () => ({
    meta: [
      { title: "Regional Forensic Signal Map — SACHSCAN" },
      {
        name: "description",
        content:
          "Tile-level forensic signal map of an evidence image using deterministic regional forensic measurements.",
      },
      {
        property: "og:title",
        content: "Regional Forensic Signal Map — SACHSCAN",
      },
      {
        property: "og:description",
        content:
          "Deterministic per-tile forensic deviation map overlaid on the evidence image.",
      },
    ],
  }),
  component: HeatmapPage,
});

const HEATMAP_NOTE =
  "Highlighted regions represent areas with stronger detected forensic signals. This visualization is indicative and does not independently prove AI generation or manipulation.";

type Mode = "Original" | "Heatmap" | "Overlay";

/**
 * Current Engine v5 regional tile.
 *
 * IMPORTANT:
 * The forensic engine stores coordinates and dimensions in pixels,
 * not normalized 0..1 coordinates.
 */
type EngineRegionalTile = {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  variance: number;
  edgeEnergy: number;
  anomaly: number;
};

type EngineRegionalAnalysis = {
  available: boolean;
  gridWidth: number;
  gridHeight: number;
  tileSize: number;
  tiles: EngineRegionalTile[];
  strongTileRatio: number;
  meanScore: number;
  maxScore: number;
  summary: string;
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Blue → cyan → amber → red.
 *
 * Intensity is encoded through colour, opacity and the numeric score.
 */
function ramp(t: number): [number, number, number] {
  const value = clamp01(t);

  const stops: [number, [number, number, number]][] = [
    [0, [12, 34, 58]],
    [0.35, [56, 225, 208]],
    [0.65, [232, 179, 58]],
    [1, [231, 76, 60]],
  ];

  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]!;
    const [p0, c0] = stops[i - 1]!;

    if (value <= p1) {
      const f = (value - p0) / (p1 - p0);

      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }

  return stops[stops.length - 1]![1];
}

function HeatmapPage() {
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

  const [mode, setMode] = useState<Mode>("Overlay");
  const [opacity, setOpacity] = useState(0.6);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const report = asReport(data?.analysis?.signals);

  /**
   * asReport currently exposes the regional object through the report type.
   * The actual persisted Engine v5 structure is normalized here so the page
   * does not depend on the old cx/cy/intensity schema.
   */
  const regional = useMemo<EngineRegionalAnalysis | null>(() => {
    const raw = report?.regional as unknown as
      | Partial<EngineRegionalAnalysis>
      | null
      | undefined;

    if (!raw) return null;

    const rawTiles = Array.isArray(raw.tiles)
      ? raw.tiles
      : [];

    const tiles: EngineRegionalTile[] = rawTiles
      .filter((tile): tile is EngineRegionalTile => {
        if (!tile || typeof tile !== "object") return false;

        const t = tile as Partial<EngineRegionalTile>;

        return (
          typeof t.x === "number" &&
          typeof t.y === "number" &&
          typeof t.width === "number" &&
          typeof t.height === "number" &&
          typeof t.score === "number" &&
          typeof t.variance === "number" &&
          typeof t.edgeEnergy === "number" &&
          typeof t.anomaly === "number"
        );
      })
      .map((tile) => ({
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
        score: tile.score,
        variance: tile.variance,
        edgeEnergy: tile.edgeEnergy,
        anomaly: tile.anomaly,
      }));

    return {
      available: Boolean(raw.available),
      gridWidth:
        typeof raw.gridWidth === "number"
          ? raw.gridWidth
          : 0,
      gridHeight:
        typeof raw.gridHeight === "number"
          ? raw.gridHeight
          : 0,
      tileSize:
        typeof raw.tileSize === "number"
          ? raw.tileSize
          : 0,
      tiles,
      strongTileRatio:
        typeof raw.strongTileRatio === "number"
          ? raw.strongTileRatio
          : 0,
      meanScore:
        typeof raw.meanScore === "number"
          ? raw.meanScore
          : 0,
      maxScore:
        typeof raw.maxScore === "number"
          ? raw.maxScore
          : 0,
      summary:
        typeof raw.summary === "string"
          ? raw.summary
          : "Regional analysis is available.",
    };
  }, [report]);

  const tiles = regional?.tiles ?? [];

  /**
   * The engine's gridWidth/gridHeight are the dimensions of the decoded
   * analysis image in pixels.
   *
   * Prefer the forensic report's real image dimensions when available.
   */
  const sourceWidth =
    report?.file.width ??
    regional?.gridWidth ??
    1;

  const sourceHeight =
    report?.file.height ??
    regional?.gridHeight ??
    1;

  /**
   * Draw heatmap using the CURRENT engine coordinates.
   *
   * Old code expected:
   *   x/y = normalized
   *   w/h = normalized
   *   intensity = 0..1
   *
   * Current engine actually provides:
   *   x/y/width/height = pixels
   *   score = 0..100
   *   anomaly = 0..1
   */
  useEffect(() => {
    const canvas = canvasRef.current;

    if (
      !canvas ||
      !regional?.available ||
      tiles.length === 0
    ) {
      return;
    }

    const canvasWidth = 1200;

    const aspectRatio =
      sourceWidth > 0 && sourceHeight > 0
        ? sourceHeight / sourceWidth
        : 1;

    const canvasHeight = Math.max(
      1,
      Math.round(canvasWidth * aspectRatio),
    );

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    const ctx = canvas.getContext("2d");

    if (!ctx) return;

    ctx.clearRect(
      0,
      0,
      canvasWidth,
      canvasHeight,
    );

    /**
     * Scale engine pixel coordinates into canvas coordinates.
     */
    const scaleX =
      canvasWidth / Math.max(1, sourceWidth);

    const scaleY =
      canvasHeight / Math.max(1, sourceHeight);

    for (const tile of tiles) {
      const intensity = clamp01(tile.anomaly);

      const [r, g, b] = ramp(intensity);

      const x = tile.x * scaleX;
      const y = tile.y * scaleY;

      const width = Math.max(
        1,
        tile.width * scaleX,
      );

      const height = Math.max(
        1,
        tile.height * scaleY,
      );

      const alpha =
        0.18 + intensity * 0.72;

      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;

      ctx.fillRect(
        x,
        y,
        width + 1,
        height + 1,
      );
    }
  }, [
    regional,
    tiles,
    sourceWidth,
    sourceHeight,
  ]);

  if (isLoading) {
    return (
      <PageShell
        title="Regional signal map"
        subtitle="Loading persisted regional analysis…"
      >
        <Panel>
          <p className="text-sm text-muted-foreground">
            Retrieving the stored tile measurements…
          </p>
        </Panel>
      </PageShell>
    );
  }

  if (error || !data) {
    return (
      <PageShell
        title="Regional signal map"
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
    previewUrl,
  } = data;

  // Keep the heatmap available only for full-verification results.
  // Demo investigations retain access so the existing demo experience works.
  const verification = (data.analysis?.signals ?? {}) as {
    verificationTier?: string;
    verificationStatus?: string;
  };
  const hasPremiumAccess = Boolean(inv.is_demo) || (
    verification.verificationTier === "full" &&
    verification.verificationStatus === "paid"
  );

  if (!hasPremiumAccess) {
    return (
      <PageShell
        title={`${inv.case_id} — AI detection heatmap`}
        subtitle="Premium regional forensic analysis"
        actions={
          <Link
            to="/investigations/$id"
            params={{ id }}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3.5 py-2 text-[13px] hover:bg-accent"
          >
            <ArrowLeft className="size-4" />
            Back to assessment
          </Link>
        }
      >
        <Panel>
          <div className="mx-auto flex max-w-xl flex-col items-center py-8 text-center">
            <div className="mb-4 flex size-14 items-center justify-center rounded-full border border-border bg-surface-2">
              <Lock className="size-6 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-semibold">AI detection heatmap is Premium</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Regional heatmaps show where image regions differ from their local forensic baseline. Complete Full Verification to unlock this analysis.
            </p>
            <Link
              to="/investigations/$id/upload"
              params={{ id }}
              className="mt-5 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Unlock Full Verification · 0.01 USDC
            </Link>
            <p className="mt-3 text-xs text-muted-foreground">
              Payment uses the existing Algorand Testnet and GoPlausible x402 flow.
            </p>
          </div>
        </Panel>
      </PageShell>
    );
  }

  const strongestTiles = [...tiles]
    .map((tile, index) => ({
      tile,
      index,
    }))
    .sort(
      (a, b) =>
        b.tile.anomaly - a.tile.anomaly,
    )
    .slice(0, 6);

  const hoveredTile =
    hoverIndex !== null
      ? tiles[hoverIndex] ?? null
      : null;

  return (
    <PageShell
      title={`${inv.case_id} — regional map`}
      subtitle="Tile-level forensic deviation from this image's own baseline"
      actions={
        <Link
          to="/investigations/$id"
          params={{ id }}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3.5 py-2 text-[13px] hover:bg-accent"
        >
          <ArrowLeft className="size-4" />
          Back to assessment
        </Link>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel
          title="Regional forensic signal map"
          right={
            <div className="flex items-center gap-1">
              {(
                [
                  "Original",
                  "Heatmap",
                  "Overlay",
                ] as Mode[]
              ).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={`mono rounded-sm border px-2 py-1 text-[10px] uppercase tracking-[0.12em] ${
                    mode === m
                      ? "border-primary text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          }
        >
          {!regional ? (
            <p className="text-sm text-muted-foreground">
              No regional analysis is stored for
              this case. Regional measurements are
              produced during a live examination.
            </p>
          ) : !regional.available ? (
            <p
              className="text-sm"
              style={{ color: "var(--warn)" }}
            >
              Regional analysis is unavailable
              for this evidence file.
            </p>
          ) : tiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Regional analysis is marked available,
              but no tile measurements were stored.
              Re-run the Full Verification analysis.
            </p>
          ) : (
            <>
              <div
                className="relative overflow-hidden rounded border border-border bg-surface-2"
                style={{
                  aspectRatio: `${sourceWidth} / ${sourceHeight}`,
                }}
              >
                {previewUrl &&
                mode !== "Heatmap" ? (
                  <img
                    src={previewUrl}
                    alt={`Evidence image for case ${inv.case_id}`}
                    className="absolute inset-0 block h-full w-full object-contain"
                  />
                ) : (
                  <div className="absolute inset-0" />
                )}

                {mode !== "Original" ? (
                  <canvas
                    ref={canvasRef}
                    aria-label="Regional forensic signal overlay"
                    className="pointer-events-none absolute inset-0 h-full w-full"
                    style={{
                      opacity:
                        mode === "Heatmap"
                          ? 1
                          : opacity,
                      mixBlendMode:
                        mode === "Heatmap"
                          ? "normal"
                          : "screen",
                    }}
                  />
                ) : null}

                {mode !== "Original" ? (
                  <div className="absolute inset-0">
                    {tiles.map(
                      (tile, index) => {
                        const left =
                          (tile.x /
                            Math.max(
                              1,
                              sourceWidth,
                            )) *
                          100;

                        const top =
                          (tile.y /
                            Math.max(
                              1,
                              sourceHeight,
                            )) *
                          100;

                        const width =
                          (tile.width /
                            Math.max(
                              1,
                              sourceWidth,
                            )) *
                          100;

                        const height =
                          (tile.height /
                            Math.max(
                              1,
                              sourceHeight,
                            )) *
                          100;

                        return (
                          <button
                            key={`${tile.x}-${tile.y}-${index}`}
                            type="button"
                            onMouseEnter={() =>
                              setHoverIndex(index)
                            }
                            onFocus={() =>
                              setHoverIndex(index)
                            }
                            onMouseLeave={() =>
                              setHoverIndex(null)
                            }
                            onBlur={() =>
                              setHoverIndex(null)
                            }
                            aria-label={`Regional tile ${index + 1}, anomaly ${tile.anomaly.toFixed(2)}`}
                            className="absolute border-0 bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                            style={{
                              left: `${left}%`,
                              top: `${top}%`,
                              width: `${width}%`,
                              height: `${height}%`,
                            }}
                          />
                        );
                      },
                    )}
                  </div>
                ) : null}

                {hoveredTile ? (
                  <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-border bg-background/90 px-3 py-2 shadow-lg backdrop-blur">
                    <div className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      Regional tile
                    </div>

                    <div className="mt-1 mono text-xs">
                      Score:{" "}
                      {hoveredTile.score}/100
                    </div>

                    <div className="mono text-xs">
                      Anomaly:{" "}
                      {hoveredTile.anomaly.toFixed(
                        2,
                      )}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Overlay opacity

                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={Math.round(
                      opacity * 100,
                    )}
                    onChange={(e) =>
                      setOpacity(
                        Number(e.target.value) /
                          100,
                      )
                    }
                    disabled={
                      mode !== "Overlay"
                    }
                    className="w-40 accent-[var(--primary)]"
                  />

                  <span className="mono">
                    {Math.round(opacity * 100)}%
                  </span>
                </label>

                <div className="flex items-center gap-2">
                  <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    Anomaly
                  </span>

                  <span className="flex h-3 w-40 overflow-hidden rounded-sm border border-border">
                    {Array.from(
                      { length: 20 },
                      (_, i) => {
                        const [r, g, b] =
                          ramp(i / 19);

                        return (
                          <span
                            key={i}
                            className="flex-1"
                            style={{
                              background: `rgb(${r},${g},${b})`,
                            }}
                          />
                        );
                      },
                    )}
                  </span>

                  <span className="mono text-[10px] text-muted-foreground">
                    0.00 → 1.00
                  </span>
                </div>
              </div>

              <p className="mt-4 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
                {HEATMAP_NOTE}
              </p>
            </>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel
            title={
              hoveredTile
                ? "Selected regional tile"
                : "Map statistics"
            }
          >
            {hoveredTile ? (
              <KeyValue
                items={[
                  {
                    k: "Tile position",
                    v: `${hoveredTile.x}, ${hoveredTile.y}`,
                    mono: true,
                  },
                  {
                    k: "Tile size",
                    v: `${hoveredTile.width} × ${hoveredTile.height} px`,
                    mono: true,
                  },
                  {
                    k: "Forensic score",
                    v: `${hoveredTile.score}/100`,
                    mono: true,
                  },
                  {
                    k: "Anomaly",
                    v: hoveredTile.anomaly.toFixed(
                      3,
                    ),
                    mono: true,
                  },
                  {
                    k: "Local variance",
                    v: hoveredTile.variance.toFixed(
                      2,
                    ),
                    mono: true,
                  },
                  {
                    k: "Local edge energy",
                    v: hoveredTile.edgeEnergy.toFixed(
                      2,
                    ),
                    mono: true,
                  },
                ]}
              />
            ) : regional?.available ? (
              <KeyValue
                items={[
                  {
                    k: "Tile grid",
                    v: `${regional.gridWidth} × ${regional.gridHeight}`,
                    mono: true,
                  },
                  {
                    k: "Tile size",
                    v: `${regional.tileSize} × ${regional.tileSize} px`,
                    mono: true,
                  },
                  {
                    k: "Source dimensions",
                    v: `${sourceWidth} × ${sourceHeight} px`,
                    mono: true,
                  },
                  {
                    k: "Mean regional score",
                    v: `${regional.meanScore.toFixed(2)}/100`,
                    mono: true,
                  },
                  {
                    k: "Peak regional score",
                    v: `${regional.maxScore}/100`,
                    mono: true,
                  },
                  {
                    k: "Strong-signal tiles",
                    v: `${Math.round(
                      regional.strongTileRatio *
                        100,
                    )}%`,
                    mono: true,
                  },
                  {
                    k: "Tile count",
                    v: `${tiles.length}`,
                    mono: true,
                  },
                ]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No tile measurements are stored
                for this case.
              </p>
            )}
          </Panel>

          {regional?.available &&
          tiles.length > 0 ? (
            <Panel title="Strongest regions">
              <ul className="space-y-2">
                {strongestTiles.map(
                  ({ tile, index }) => {
                    const intensity =
                      clamp01(tile.anomaly);

                    return (
                      <li
                        key={`${tile.x}-${tile.y}-${index}`}
                        className="flex items-center gap-3 text-xs"
                      >
                        <span
                          className="size-3 shrink-0 rounded-sm border border-border"
                          style={{
                            background: `rgb(${ramp(
                              intensity,
                            ).join(",")})`,
                          }}
                        />

                        <span className="mono">
                          {tile.x},{" "}
                          {tile.y}
                        </span>

                        <span className="text-muted-foreground">
                          score
                        </span>

                        <span className="mono ml-auto">
                          {tile.score}/100
                        </span>
                      </li>
                    );
                  },
                )}
              </ul>

              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {regional.summary}
              </p>
            </Panel>
          ) : null}

          <Disclaimer />
        </div>
      </div>
    </PageShell>
  );
}