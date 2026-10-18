/**
 * Regional forensic signal map (server-side, deterministic).
 *
 * The image is decoded once, resampled onto a fixed-aspect luminance grid and
 * partitioned into tiles. For every tile four independent local statistics are
 * measured from the actual pixels:
 *
 *   1. noise      — mean absolute neighbour difference (high-frequency energy)
 *   2. texture    — local luminance variance (detail / smoothness)
 *   3. edge       — mean Sobel gradient magnitude
 *   4. blockiness — discontinuity across 8-pixel boundaries (recompression)
 *
 * Each tile's intensity is the mean of robust deviations of those four values
 * from the image-wide median (median absolute deviation scaling), so intensity
 * answers "how unlike the rest of this image is this region?" — never a random
 * or hard-coded value. Identical bytes always produce an identical map.
 */
import jpeg from "jpeg-js";
import { decode as decodePng } from "fast-png";

export const REGIONAL_VERSION = 1;

export interface RegionTile {
  /** Tile column / row indices. */
  cx: number;
  cy: number;
  /** Normalised tile rectangle in image space (0..1), for aspect-safe overlay. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..1 combined anomaly intensity. */
  intensity: number;
  metrics: { noise: number; texture: number; edge: number; blockiness: number };
  deviations: { noise: number; texture: number; edge: number; blockiness: number };
}

export interface RegionalMap {
  version: number;
  available: boolean;
  reason?: string;
  cols: number;
  rows: number;
  /** Source dimensions the map was computed from. */
  sourceWidth: number;
  sourceHeight: number;
  /** Analysis grid the tiles were measured on (working copy, evidence untouched). */
  gridWidth: number;
  gridHeight: number;
  tiles: RegionTile[];
  baseline: { noise: number; texture: number; edge: number; blockiness: number };
  /** Fraction of tiles above the strong-signal threshold. */
  strongTileRatio: number;
  /** Highest tile intensity. */
  peakIntensity: number;
  summary: string;
}

const STRONG = 0.55;

function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function mad(v: number[], med: number): number {
  if (v.length === 0) return 0;
  return median(v.map((x) => Math.abs(x - med)));
}

function decodeLuma(
  format: string,
  bytes: Uint8Array,
): { width: number; height: number; luma: Float64Array } | { error: string } {
  try {
    let width = 0;
    let height = 0;
    let data: Uint8Array | Uint8ClampedArray | Uint16Array;
    let channels = 4;
    if (format === "JPEG") {
      const d = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 512 });
      width = d.width;
      height = d.height;
      data = d.data;
    } else if (format === "PNG") {
      const d = decodePng(bytes);
      width = d.width;
      height = d.height;
      channels = d.channels ?? 4;
      if (d.depth === 16) {
        const src = d.data as Uint16Array;
        const conv = new Uint8Array(src.length);
        for (let i = 0; i < src.length; i++) conv[i] = src[i]! >> 8;
        data = conv;
      } else {
        data = d.data as Uint8Array;
      }
    } else {
      return { error: `Regional analysis is not supported for ${format} in this prototype.` };
    }
    if (!width || !height) return { error: "Decoded image reported no dimensions." };

    // Working copy, aspect-preserving, bounded cost. The stored evidence file
    // is never modified.
    const MAX = 512;
    const scale = Math.min(1, MAX / Math.max(width, height));
    const gw = Math.max(1, Math.round(width * scale));
    const gh = Math.max(1, Math.round(height * scale));
    const luma = new Float64Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      const sy = Math.min(height - 1, Math.floor((y * height) / gh));
      for (let x = 0; x < gw; x++) {
        const sx = Math.min(width - 1, Math.floor((x * width) / gw));
        const i = (sy * width + sx) * channels;
        const r = data[i] ?? 0;
        const g = channels >= 3 ? (data[i + 1] ?? r) : r;
        const b = channels >= 3 ? (data[i + 2] ?? r) : r;
        luma[y * gw + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }
    return { width: gw, height: gh, luma };
  } catch (e) {
    return { error: `Image could not be decoded for regional analysis (${(e as Error).message}).` };
  }
}

export function computeRegionalMap(
  format: string,
  bytes: Uint8Array,
  sourceWidth: number | null,
  sourceHeight: number | null,
): RegionalMap {
  const empty = (reason: string): RegionalMap => ({
    version: REGIONAL_VERSION,
    available: false,
    reason,
    cols: 0,
    rows: 0,
    sourceWidth: sourceWidth ?? 0,
    sourceHeight: sourceHeight ?? 0,
    gridWidth: 0,
    gridHeight: 0,
    tiles: [],
    baseline: { noise: 0, texture: 0, edge: 0, blockiness: 0 },
    strongTileRatio: 0,
    peakIntensity: 0,
    summary: reason,
  });

  const decoded = decodeLuma(format, bytes);
  if ("error" in decoded) return empty(decoded.error);
  const { width: gw, height: gh, luma } = decoded;
  if (gw < 32 || gh < 32) return empty("Image is too small for regional tile analysis.");

  // Tile size scales with the working copy so any aspect ratio yields a grid of
  // roughly 12-20 tiles on the longer edge.
  const tile = Math.max(16, Math.round(Math.max(gw, gh) / 16));
  const cols = Math.max(2, Math.floor(gw / tile));
  const rows = Math.max(2, Math.floor(gh / tile));

  const raw: { cx: number; cy: number; noise: number; texture: number; edge: number; blockiness: number }[] = [];

  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor((cy * gh) / rows);
    const y1 = Math.floor(((cy + 1) * gh) / rows);
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * gw) / cols);
      const x1 = Math.floor(((cx + 1) * gw) / cols);

      let sum = 0;
      let sumSq = 0;
      let n = 0;
      let noiseSum = 0;
      let noiseN = 0;
      let edgeSum = 0;
      let edgeN = 0;
      let blockSum = 0;
      let blockN = 0;
      let interSum = 0;
      let interN = 0;

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = luma[y * gw + x]!;
          sum += v;
          sumSq += v * v;
          n++;
          if (x + 1 < gw) {
            const d = Math.abs(v - luma[y * gw + x + 1]!);
            noiseSum += d;
            noiseN++;
            // 8-pixel boundary discontinuity vs. interior differences
            if ((x + 1) % 8 === 0) {
              blockSum += d;
              blockN++;
            } else {
              interSum += d;
              interN++;
            }
          }
          if (y + 1 < gh) {
            noiseSum += Math.abs(v - luma[(y + 1) * gw + x]!);
            noiseN++;
          }
          if (x > 0 && y > 0 && x + 1 < gw && y + 1 < gh) {
            const p = (xx: number, yy: number) => luma[yy * gw + xx]!;
            const gx =
              p(x - 1, y - 1) + 2 * p(x - 1, y) + p(x - 1, y + 1) - p(x + 1, y - 1) - 2 * p(x + 1, y) - p(x + 1, y + 1);
            const gy =
              p(x - 1, y - 1) + 2 * p(x, y - 1) + p(x + 1, y - 1) - p(x - 1, y + 1) - 2 * p(x, y + 1) - p(x + 1, y + 1);
            edgeSum += Math.hypot(gx, gy);
            edgeN++;
          }
        }
      }

      const mean = n ? sum / n : 0;
      const interMean = interN ? interSum / interN : 0;
      const blockMean = blockN ? blockSum / blockN : 0;
      raw.push({
        cx,
        cy,
        noise: noiseN ? noiseSum / noiseN : 0,
        texture: n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0,
        edge: edgeN ? edgeSum / edgeN : 0,
        blockiness: interMean > 0.0001 ? blockMean / interMean : 0,
      });
    }
  }

  const keys = ["noise", "texture", "edge", "blockiness"] as const;
  const baseline = {} as Record<(typeof keys)[number], number>;
  const spread = {} as Record<(typeof keys)[number], number>;
  for (const k of keys) {
    const vals = raw.map((t) => t[k]);
    const med = median(vals);
    baseline[k] = med;
    // Robust scale; falls back to a small fraction of the median so a perfectly
    // uniform image yields zero deviation rather than a divide-by-zero spike.
    spread[k] = Math.max(mad(vals, med) * 1.4826, Math.abs(med) * 0.15, 1e-6);
  }

  const tiles: RegionTile[] = raw.map((t) => {
    const dev = {} as Record<(typeof keys)[number], number>;
    for (const k of keys) {
      const z = Math.abs(t[k] - baseline[k]) / spread[k];
      dev[k] = Math.min(1, z / 3); // 3 robust sigma == full intensity
    }
    const intensity = Math.min(
      1,
      (dev.noise * 0.32 + dev.texture * 0.24 + dev.edge * 0.24 + dev.blockiness * 0.2) * 1.15,
    );
    return {
      cx: t.cx,
      cy: t.cy,
      x: t.cx / cols,
      y: t.cy / rows,
      w: 1 / cols,
      h: 1 / rows,
      intensity: Math.round(intensity * 1000) / 1000,
      metrics: {
        noise: Math.round(t.noise * 1000) / 1000,
        texture: Math.round(t.texture * 1000) / 1000,
        edge: Math.round(t.edge * 1000) / 1000,
        blockiness: Math.round(t.blockiness * 1000) / 1000,
      },
      deviations: {
        noise: Math.round(dev.noise * 1000) / 1000,
        texture: Math.round(dev.texture * 1000) / 1000,
        edge: Math.round(dev.edge * 1000) / 1000,
        blockiness: Math.round(dev.blockiness * 1000) / 1000,
      },
    };
  });

  const strong = tiles.filter((t) => t.intensity >= STRONG).length;
  const strongTileRatio = tiles.length ? Math.round((strong / tiles.length) * 1000) / 1000 : 0;
  const peakIntensity = tiles.reduce((m, t) => Math.max(m, t.intensity), 0);

  const summary =
    strong === 0
      ? `No region deviates strongly from the image-wide baseline across ${tiles.length} tiles; local noise, texture, edge and compression statistics are consistent throughout the frame.`
      : `${strong} of ${tiles.length} tiles (${Math.round(strongTileRatio * 100)}%) deviate strongly from the image-wide baseline, with a peak regional intensity of ${peakIntensity.toFixed(2)}. Deviations of this kind can arise from legitimate content variation as well as localised editing.`;

  return {
    version: REGIONAL_VERSION,
    available: true,
    cols,
    rows,
    sourceWidth: sourceWidth ?? gw,
    sourceHeight: sourceHeight ?? gh,
    gridWidth: gw,
    gridHeight: gh,
    tiles,
    baseline: {
      noise: Math.round(baseline.noise * 1000) / 1000,
      texture: Math.round(baseline.texture * 1000) / 1000,
      edge: Math.round(baseline.edge * 1000) / 1000,
      blockiness: Math.round(baseline.blockiness * 1000) / 1000,
    },
    strongTileRatio,
    peakIntensity,
    summary,
  };
}
