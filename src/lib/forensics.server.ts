/**
 * SACHSCAN deterministic forensic engine.
 *
 * Every value produced here is computed from the actual bytes of the actual
 * uploaded file. There is NO randomness anywhere in this module: analysing the
 * same bytes twice always produces byte-identical output.
 *
 * This is a transparent heuristic engine, not a trained classifier.
 */

import exifr from "exifr";
import jpeg from "jpeg-js";
import { decode as decodePng } from "fast-png";

export type SignalStatus = "supportive" | "inconsistent" | "unavailable";

export interface EvidenceSignal {
  key: string;
  label: string;
  value: string;
  status: SignalStatus;
  detail: string;
}

export interface Finding {
  id: string;
  title: string;
  severity: "INFORMATIONAL" | "LOW" | "MODERATE" | "HIGH";
  confidence: number;
  signalType: string;
  explanation: string;
}

/**
 * Bumped whenever the scoring model changes.
 */
export const ENGINE_VERSION = 5;

/**
 * Regional forensic tile used by the paid Full Verification heatmap.
 *
 * These are deterministic statistical regions derived from the decoded image.
 * They are NOT AI segmentation masks.
 */
export interface RegionalTile {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  variance: number;
  edgeEnergy: number;
  anomaly: number;
}

export interface RegionalForensicAnalysis {
  available: boolean;
  gridWidth: number;
  gridHeight: number;
  tileSize: number;
  tiles: RegionalTile[];
  strongTileRatio: number;
  meanScore: number;
  maxScore: number;
  summary: string;
}

export interface ForensicReport {
  engineVersion: number;
  fileHash: string;

  file: {
    detectedFormat: string;
    detectedMime: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    aspectRatio: string | null;
  };

  exif: Record<string, string | number | boolean | null>;

  metadataStatus:
    | "INTACT"
    | "PARTIALLY_AVAILABLE"
    | "MISSING"
    | "INCONSISTENT"
    | "UNKNOWN";

  metadataStatusReason: string;

  imageStats: PixelStats;

  jpeg: {
    isJpeg: boolean;
    quantizationSum?: number | undefined;
    estimatedQuality?: number | undefined;
    chromaSubsampling?: string | undefined;
  };

  c2paPresent: boolean;

  signals: EvidenceSignal[];

  signalBreakdown: {
    signal: string;
    weight: number;
    normalized: number;
    contribution: number;
    scope: "ai" | "manipulation";
  }[];

  findings: Finding[];

  aiProbability: number;
  manipulationProbability: number;
  authenticityConfidence: number;

  confidenceStatus: "SUFFICIENT" | "INSUFFICIENT_EVIDENCE";
  confidenceReason: string;

  riskLevel: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

  aiBand: string;
  manipulationBand: string;

  summary: string;

  availableSignalCount: number;

  /**
   * Regional forensic data used by the Full Verification heatmap.
   */
  regional: RegionalForensicAnalysis;
}

/**
 * Documented weighted-sum scoring model.
 */
export const SCORING_WEIGHTS = {
  ai: {
    generatorSoftwareTag: 55,
    c2paGenerativeCredential: 70,
    commonGeneratorResolution: 6,
    noCameraIndicatorsWithSoftware: 10,

    lowNoiseFloor: 20,
    uniformNoiseTexture: 18,
    edgeEnergyUniformity: 16,
    lowColorEntropy: 12,
    periodicPattern: 10,
    uniformLuminance: 6,
    metadataVacuumWithSmoothPixels: 10,
  },

  manipulation: {
    metadataInconsistency: 35,
    recompressionAnomaly: 22,
    chromaSubsamplingMismatch: 8,
    heavyEditorSoftwareTag: 30,
    dimensionsNotCameraLike: 6,
  },
} as const;

const GENERATIVE_TOOL_PATTERNS = [
  "midjourney",
  "dall",
  "stable diffusion",
  "stablediffusion",
  "automatic1111",
  "comfyui",
  "leonardo",
  "firefly",
  "imagen",
  "flux",
  "ideogram",
  "nightcafe",
  "novelai",
  "invokeai",
  "dream by wombo",
  "gemini",
  "nano banana",
];

const HEAVY_EDITOR_PATTERNS = [
  "photoshop",
  "lightroom",
  "gimp",
  "affinity",
  "pixelmator",
  "snapseed",
  "picsart",
  "facetune",
  "canva",
  "paint.net",
  "luminar",
];

const GENERATOR_RESOLUTIONS = new Set([
  "512x512",
  "576x1024",
  "640x640",
  "768x768",
  "768x1344",
  "832x1216",
  "896x1152",
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "1024x1792",
  "1792x1024",
  "1344x768",
  "1216x832",
  "1152x896",
  "2048x2048",
]);

function toHexPrefix(bytes: Uint8Array, len: number): string {
  return Array.from(bytes.slice(0, len))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes);

  const digest = await crypto.subtle.digest(
    "SHA-256",
    view.buffer as ArrayBuffer,
  );

  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sniffFormat(
  bytes: Uint8Array,
): { format: string; mime: string } {
  const head = toHexPrefix(bytes, 12);

  if (head.startsWith("FFD8FF")) {
    return {
      format: "JPEG",
      mime: "image/jpeg",
    };
  }

  if (head.startsWith("89504E470D0A1A0A")) {
    return {
      format: "PNG",
      mime: "image/png",
    };
  }

  if (
    head.startsWith("52494646") &&
    head.slice(16, 24) === "57454250"
  ) {
    return {
      format: "WEBP",
      mime: "image/webp",
    };
  }

  if (head.startsWith("47494638")) {
    return {
      format: "GIF",
      mime: "image/gif",
    };
  }

  return {
    format: "UNKNOWN",
    mime: "application/octet-stream",
  };
}

interface JpegStructure {
  width: number | null;
  height: number | null;
  quantizationSum?: number | undefined;
  estimatedQuality?: number | undefined;
  chromaSubsampling?: string | undefined;
}

/**
 * Walk JPEG markers for dimensions, sampling factors and quantisation tables.
 */
function parseJpegStructure(bytes: Uint8Array): JpegStructure {
  const out: JpegStructure = {
    width: null,
    height: null,
  };

  let i = 2;
  let quantSum = 0;
  let quantCount = 0;

  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }

    const marker = bytes[i + 1]!;

    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }

    if (marker === 0xda || marker === 0xd9) {
      break;
    }

    const length =
      (bytes[i + 2]! << 8) | bytes[i + 3]!;

    const segStart = i + 4;

    if (marker === 0xdb) {
      let p = segStart;
      const end = i + 2 + length;

      while (p < end && p < bytes.length) {
        const pq = bytes[p]! >> 4;
        p += 1;

        const count = 64;

        for (let k = 0; k < count; k++) {
          const v =
            pq === 0
              ? bytes[p + k]!
              : (bytes[p + k * 2]! << 8) |
                bytes[p + k * 2 + 1]!;

          quantSum += v;
          quantCount++;
        }

        p += pq === 0 ? 64 : 128;
      }
    } else if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      out.height =
        (bytes[segStart + 1]! << 8) |
        bytes[segStart + 2]!;

      out.width =
        (bytes[segStart + 3]! << 8) |
        bytes[segStart + 4]!;

      const components = bytes[segStart + 5]!;

      if (components >= 1) {
        const hv = bytes[segStart + 7]!;
        const h = hv >> 4;
        const v = hv & 0x0f;

        out.chromaSubsampling =
          components === 1
            ? "grayscale"
            : h === 2 && v === 2
              ? "4:2:0"
              : h === 2 && v === 1
                ? "4:2:2"
                : h === 1 && v === 1
                  ? "4:4:4"
                  : `${h}x${v}`;
      }
    }

    i += 2 + length;
  }

  if (quantCount > 0) {
    out.quantizationSum = quantSum;

    const avg = quantSum / quantCount;

    const quality =
      avg <= 1
        ? 100
        : avg < 12
          ? Math.round(100 - avg * 4)
          : Math.max(1, Math.round(100 - avg * 1.6));

    out.estimatedQuality = Math.min(
      100,
      Math.max(1, quality),
    );
  }

  return out;
}

function parsePngDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 24) {
    return null;
  }

  const view = new DataView(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength,
  );

  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
}

function parseWebpDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const tag = String.fromCharCode(
    ...bytes.slice(12, 16),
  );

  try {
    if (tag === "VP8X") {
      const w =
        1 +
        (bytes[24]! |
          (bytes[25]! << 8) |
          (bytes[26]! << 16));

      const h =
        1 +
        (bytes[27]! |
          (bytes[28]! << 8) |
          (bytes[29]! << 16));

      return {
        width: w,
        height: h,
      };
    }

    if (tag === "VP8 ") {
      const w =
        ((bytes[27]! | (bytes[28]! << 8)) &
          0x3fff) as number;

      const h =
        ((bytes[29]! | (bytes[30]! << 8)) &
          0x3fff) as number;

      return {
        width: w,
        height: h,
      };
    }

    if (tag === "VP8L") {
      const b = bytes.slice(21, 26);

      const bits =
        b[0]! |
        (b[1]! << 8) |
        (b[2]! << 16) |
        (b[3]! << 24);

      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export interface PixelStats {
  available: boolean;
  reason?: string | undefined;

  luminanceMean?: number | undefined;
  luminanceStdDev?: number | undefined;

  noiseFloor?: number | undefined;
  sampledPixels?: number | undefined;

  blockVarianceMean?: number | undefined;
  noiseIrregularity?: number | undefined;

  edgeEnergyMean?: number | undefined;
  edgeUniformity?: number | undefined;

  colorEntropy?: number | undefined;

  periodicity?: number | undefined;

  /**
   * Regional data for the forensic heatmap.
   */
  regional?: RegionalForensicAnalysis | undefined;
}

/**
 * Deterministic pixel statistics.
 *
 * The regional map is derived from the same sampled image grid and therefore
 * requires no separate AI model or random process.
 */
function computePixelStats(
  format: string,
  bytes: Uint8Array,
): PixelStats {
  let width = 0;
  let height = 0;

  let data:
    | Uint8Array
    | Uint8ClampedArray
    | Uint16Array;

  let channels = 4;

  try {
    if (format === "JPEG") {
      const decoded = jpeg.decode(bytes, {
        useTArray: true,
        maxMemoryUsageInMB: 512,
      });

      width = decoded.width;
      height = decoded.height;
      data = decoded.data;
      channels = 4;
    } else if (format === "PNG") {
      const decoded = decodePng(bytes);

      width = decoded.width;
      height = decoded.height;

      data = decoded.data as Uint8Array;
      channels = decoded.channels ?? 4;

      if (decoded.depth === 16) {
        const src = decoded.data as Uint16Array;
        const conv = new Uint8Array(src.length);

        for (let i = 0; i < src.length; i++) {
          conv[i] = src[i]! >> 8;
        }

        data = conv;
      }
    } else {
      return {
        available: false,
        reason: `Pixel decoding is not supported for ${format} in this prototype.`,
      };
    }
  } catch (e) {
    return {
      available: false,
      reason: `Image could not be decoded for pixel analysis (${(e as Error).message}).`,
    };
  }

  if (!width || !height) {
    return {
      available: false,
      reason: "Decoded image reported no dimensions.",
    };
  }

  const GRID = 256;

  const gw = Math.min(GRID, width);
  const gh = Math.min(GRID, height);

  if (gw < 16 || gh < 16) {
    return {
      available: false,
      reason: "Image is too small for pixel-level statistics.",
    };
  }

  const px = (x: number, y: number) => {
    const idx = (y * width + x) * channels;

    const r = data[idx] ?? 0;

    const g =
      channels >= 3
        ? data[idx + 1] ?? 0
        : r;

    const b =
      channels >= 3
        ? data[idx + 2] ?? 0
        : r;

    return [r, g, b] as const;
  };

  const lumOf = (
    r: number,
    g: number,
    b: number,
  ) =>
    0.299 * r +
    0.587 * g +
    0.114 * b;

  const grid = new Float64Array(gw * gh);

  const hist = [
    new Uint32Array(64),
    new Uint32Array(64),
    new Uint32Array(64),
  ];

  let sum = 0;
  let sumSq = 0;

  let diffSum = 0;
  let diffN = 0;

  for (let gy = 0; gy < gh; gy++) {
    const sy = Math.min(
      height - 1,
      Math.floor((gy * height) / gh),
    );

    for (let gx = 0; gx < gw; gx++) {
      const sx = Math.min(
        width - 1,
        Math.floor((gx * width) / gw),
      );

      const [r, g, b] = px(sx, sy);

      const l = lumOf(r, g, b);

      grid[gy * gw + gx] = l;

      sum += l;
      sumSq += l * l;

      hist[0]![r >> 2]!++;
      hist[1]![g >> 2]!++;
      hist[2]![b >> 2]!++;

      if (
        sx + 1 < width &&
        sy + 1 < height
      ) {
        const [r1, g1, b1] = px(
          sx + 1,
          sy,
        );

        const [r2, g2, b2] = px(
          sx,
          sy + 1,
        );

        diffSum +=
          Math.abs(
            l - lumOf(r1, g1, b1),
          ) +
          Math.abs(
            l - lumOf(r2, g2, b2),
          );

        diffN += 2;
      }
    }
  }

  const n = gw * gh;

  const mean = sum / n;

  const variance = Math.max(
    0,
    sumSq / n - mean * mean,
  );

  // ------------------------------------------------------------
  // BLOCK VARIANCE
  // ------------------------------------------------------------

  const B = 8;

  const blockVars: number[] = [];
  const blockEdges: number[] = [];

  for (
    let by = 0;
    by + B <= gh;
    by += B
  ) {
    for (
      let bx = 0;
      bx + B <= gw;
      bx += B
    ) {
      let bs = 0;
      let bss = 0;

      for (
        let y = by;
        y < by + B;
        y++
      ) {
        for (
          let x = bx;
          x < bx + B;
          x++
        ) {
          const v =
            grid[y * gw + x]!;

          bs += v;
          bss += v * v;
        }
      }

      const cnt = B * B;

      const bm = bs / cnt;

      blockVars.push(
        Math.max(
          0,
          bss / cnt - bm * bm,
        ),
      );
    }
  }

  const bvMean =
    blockVars.reduce(
      (a, v) => a + v,
      0,
    ) /
    Math.max(
      1,
      blockVars.length,
    );

  const bvStd = Math.sqrt(
    blockVars.reduce(
      (a, v) =>
        a +
        (v - bvMean) *
          (v - bvMean),
      0,
    ) /
      Math.max(
        1,
        blockVars.length,
      ),
  );

  const noiseIrregularity =
    bvMean > 0
      ? bvStd / bvMean
      : 0;

  // ------------------------------------------------------------
  // SOBEL EDGE ENERGY
  // ------------------------------------------------------------

  let edgeSum = 0;
  let edgeN = 0;

  const edgeMap =
    new Float64Array(
      gw * gh,
    );

  for (
    let y = 1;
    y < gh - 1;
    y++
  ) {
    for (
      let x = 1;
      x < gw - 1;
      x++
    ) {
      const g00 =
        grid[
          (y - 1) * gw +
            (x - 1)
        ]!;

      const g01 =
        grid[
          (y - 1) * gw + x
        ]!;

      const g02 =
        grid[
          (y - 1) * gw +
            (x + 1)
        ]!;

      const g10 =
        grid[
          y * gw + (x - 1)
        ]!;

      const g12 =
        grid[
          y * gw + (x + 1)
        ]!;

      const g20 =
        grid[
          (y + 1) * gw +
            (x - 1)
        ]!;

      const g21 =
        grid[
          (y + 1) * gw + x
        ]!;

      const g22 =
        grid[
          (y + 1) * gw +
            (x + 1)
        ]!;

      const gxv =
        g02 +
        2 * g12 +
        g22 -
        (g00 + 2 * g10 + g20);

      const gyv =
        g20 +
        2 * g21 +
        g22 -
        (g00 + 2 * g01 + g02);

      const m = Math.sqrt(
        gxv * gxv +
          gyv * gyv,
      );

      edgeMap[
        y * gw + x
      ] = m;

      edgeSum += m;
      edgeN++;
    }
  }

  const edgeMean =
    edgeN > 0
      ? edgeSum / edgeN
      : 0;

  for (
    let by = 0;
    by + B <= gh;
    by += B
  ) {
    for (
      let bx = 0;
      bx + B <= gw;
      bx += B
    ) {
      let es = 0;

      for (
        let y = by;
        y < by + B;
        y++
      ) {
        for (
          let x = bx;
          x < bx + B;
          x++
        ) {
          es +=
            edgeMap[
              y * gw + x
            ]!;
        }
      }

      blockEdges.push(
        es / (B * B),
      );
    }
  }

  const beMean =
    blockEdges.reduce(
      (a, v) => a + v,
      0,
    ) /
    Math.max(
      1,
      blockEdges.length,
    );

  const beStd = Math.sqrt(
    blockEdges.reduce(
      (a, v) =>
        a +
        (v - beMean) *
          (v - beMean),
      0,
    ) /
      Math.max(
        1,
        blockEdges.length,
      ),
  );

  const edgeUniformity =
    beMean > 0
      ? Math.max(
          0,
          1 - beStd / beMean,
        )
      : 0;

  // ------------------------------------------------------------
  // REGIONAL FORENSIC MAP
  // ------------------------------------------------------------

  const blocksX = Math.floor(
    gw / B,
  );

  const blocksY = Math.floor(
    gh / B,
  );

  const regionalTiles: RegionalTile[] =
    [];

  for (
    let by = 0;
    by < blocksY;
    by++
  ) {
    for (
      let bx = 0;
      bx < blocksX;
      bx++
    ) {
      const index =
        by * blocksX + bx;

      const variance =
        blockVars[index] ?? 0;

      const edgeEnergy =
        blockEdges[index] ?? 0;

      const varianceDeviation =
        bvMean > 1e-9
          ? Math.min(
              1,
              Math.abs(
                variance -
                  bvMean,
              ) /
                (bvMean * 1.5 +
                  1),
            )
          : 0;

      const edgeDeviation =
        beMean > 1e-9
          ? Math.min(
              1,
              Math.abs(
                edgeEnergy -
                  beMean,
              ) /
                (beMean * 0.9 +
                  1),
            )
          : 0;

      const anomaly = Math.min(
        1,
        varianceDeviation *
            0.55 +
          edgeDeviation *
            0.45,
      );

      regionalTiles.push({
        x: bx * B,
        y: by * B,
        width: B,
        height: B,

        score: Math.round(
          anomaly * 100,
        ),

        variance: round2(
          variance,
        ),

        edgeEnergy: round2(
          edgeEnergy,
        ),

        anomaly: round2(
          anomaly,
        ),
      });
    }
  }

  const strongTileCount =
    regionalTiles.filter(
      (tile) =>
        tile.score >= 60,
    ).length;

  const strongTileRatio =
    regionalTiles.length
      ? round2(
          strongTileCount /
            regionalTiles.length,
        )
      : 0;

  const meanRegionalScore =
    regionalTiles.length
      ? round2(
          regionalTiles.reduce(
            (sum, tile) =>
              sum + tile.score,
            0,
          ) /
            regionalTiles.length,
        )
      : 0;

  const maxRegionalScore =
    regionalTiles.length
      ? Math.max(
          ...regionalTiles.map(
            (tile) =>
              tile.score,
          ),
        )
      : 0;

  const regionalSummary =
    regionalTiles.length
      ? strongTileRatio > 0.1
        ? `${Math.round(
            strongTileRatio * 100,
          )}% of sampled image tiles show strong local deviation from the image-wide variance/edge baseline.`
        : `Regional analysis found no strong local anomaly concentration; ${Math.round(
            (1 - strongTileRatio) *
              100,
          )}% of sampled tiles remain below the strong-anomaly threshold.`
      : "Regional pixel analysis was unavailable for this image.";

  const regional: RegionalForensicAnalysis =
    {
      available:
        regionalTiles.length > 0,

      gridWidth: blocksX,
      gridHeight: blocksY,

      tileSize: B,

      tiles: regionalTiles,

      strongTileRatio,

      meanScore:
        meanRegionalScore,

      maxScore:
        maxRegionalScore,

      summary:
        regionalSummary,
    };

  // ------------------------------------------------------------
  // HISTOGRAM ENTROPY
  // ------------------------------------------------------------

  const entropyOf = (
    h: Uint32Array,
  ) => {
    let e = 0;

    for (const c of h) {
      if (!c) continue;

      const p = c / n;

      e -=
        p * Math.log2(p);
    }

    return (
      e / Math.log2(64)
    );
  };

  const colorEntropy =
    (entropyOf(hist[0]!) +
      entropyOf(hist[1]!) +
      entropyOf(hist[2]!)) /
    3;

  // ------------------------------------------------------------
  // PERIODICITY
  // ------------------------------------------------------------

  const profile = (
    axis: "row" | "col",
  ) => {
    const len =
      axis === "row"
        ? gh
        : gw;

    const other =
      axis === "row"
        ? gw
        : gh;

    const out =
      new Float64Array(len);

    for (
      let i = 0;
      i < len;
      i++
    ) {
      let s = 0;

      for (
        let j = 0;
        j < other;
        j++
      ) {
        s +=
          axis === "row"
            ? grid[
                i * gw + j
              ]!
            : grid[
                j * gw + i
              ]!;
      }

      out[i] =
        s / other;
    }

    return out;
  };

  const maxAutocorr = (
    sig: Float64Array,
  ) => {
    const m =
      sig.reduce(
        (a, v) => a + v,
        0,
      ) /
      sig.length;

    let denom = 0;

    for (const v of sig) {
      denom +=
        (v - m) *
        (v - m);
    }

    if (denom <= 1e-9) {
      return 0;
    }

    let best = 0;

    for (
      let lag = 2;
      lag <=
      Math.min(
        24,
        Math.floor(
          sig.length / 3,
        ),
      );
      lag++
    ) {
      let num = 0;

      for (
        let i = 0;
        i + lag <
        sig.length;
        i++
      ) {
        num +=
          (sig[i]! - m) *
          (sig[i + lag]! - m);
      }

      best = Math.max(
        best,
        num / denom,
      );
    }

    return Math.max(
      0,
      Math.min(1, best),
    );
  };

  const periodicity =
    Math.max(
      maxAutocorr(
        profile("row"),
      ),
      maxAutocorr(
        profile("col"),
      ),
    );

  return {
    available: true,

    luminanceMean:
      round2(mean),

    luminanceStdDev:
      round2(
        Math.sqrt(variance),
      ),

    noiseFloor:
      round2(
        diffN
          ? diffSum / diffN
          : 0,
      ),

    sampledPixels: n,

    blockVarianceMean:
      round2(bvMean),

    noiseIrregularity:
      round2(
        noiseIrregularity,
      ),

    edgeEnergyMean:
      round2(edgeMean),

    edgeUniformity:
      round2(edgeUniformity),

    colorEntropy:
      round2(colorEntropy),

    periodicity:
      round2(periodicity),

    regional,
  };
}

function round2(
  v: number,
): number {
  return (
    Math.round(v * 100) / 100
  );
}

function band(
  score: number,
): string {
  if (score <= 20) {
    return "Low";
  }

  if (score <= 40) {
    return "Mild";
  }

  if (score <= 60) {
    return "Moderate";
  }

  if (score <= 80) {
    return "High";
  }

  return "Very High";
}

function containsAny(
  haystack: string,
  needles: string[],
): string | null {
  const h =
    haystack.toLowerCase();

  for (const n of needles) {
    if (h.includes(n)) {
      return n;
    }
  }

  return null;
}

function gcd(
  a: number,
  b: number,
): number {
  return b === 0
    ? a
    : gcd(b, a % b);
}

export async function analyzeBytes(
  bytes: Uint8Array,
  declaredName: string,
): Promise<ForensicReport> {
  const fileHash =
    await sha256Hex(bytes);

  const {
    format,
    mime,
  } = sniffFormat(bytes);

  const jpegStruct =
    format === "JPEG"
      ? parseJpegStructure(bytes)
      : {
          width: null,
          height: null,
        };

  let width:
    | number
    | null =
    jpegStruct.width;

  let height:
    | number
    | null =
    jpegStruct.height;

  if (format === "PNG") {
    const d =
      parsePngDimensions(
        bytes,
      );

    width =
      d?.width ?? null;

    height =
      d?.height ?? null;
  } else if (
    format === "WEBP"
  ) {
    const d =
      parseWebpDimensions(
        bytes,
      );

    width =
      d?.width ?? null;

    height =
      d?.height ?? null;
  }

  // ------------------------------------------------------------
  // EXIF / XMP
  // ------------------------------------------------------------

  let exifRaw:
    Record<
      string,
      unknown
    > = {};

  try {
    const parsed =
      await exifr.parse(
        bytes as unknown as ArrayBufferLike,
        {
          tiff: true,
          exif: true,
          gps: true,
          xmp: true,
          iptc: true,
          mergeOutput: true,
        },
      );

    if (
      parsed &&
      typeof parsed === "object"
    ) {
      exifRaw =
        parsed as Record<
          string,
          unknown
        >;
    }
  } catch {
    exifRaw = {};
  }

  const str = (
    v: unknown,
  ): string | null =>
    v === undefined ||
    v === null
      ? null
      : typeof v === "string"
        ? v
        : v instanceof Date
          ? v.toISOString()
          : String(v);

  const make =
    str(exifRaw["Make"]);

  const model =
    str(exifRaw["Model"]);

  const software =
    str(exifRaw["Software"]) ??
    str(
      exifRaw["CreatorTool"],
    ) ??
    str(
      exifRaw["creatortool"],
    );

  const dateTimeOriginal =
    str(
      exifRaw[
        "DateTimeOriginal"
      ],
    ) ??
    str(
      exifRaw["CreateDate"],
    );

  const modifyDate =
    str(
      exifRaw["ModifyDate"],
    );

  const orientation =
    str(
      exifRaw["Orientation"],
    );

  const colorSpace =
    str(
      exifRaw["ColorSpace"],
    );

  const lens =
    str(
      exifRaw["LensModel"],
    );

  const gpsPresent =
    exifRaw["latitude"] !==
      undefined ||
    exifRaw["GPSLatitude"] !==
      undefined ||
    exifRaw["GPSLongitude"] !==
      undefined;

  const exifKeyCount =
    Object.keys(exifRaw).length;

  const cameraIndicators =
    Boolean(
      make ||
        model ||
        lens ||
        exifRaw["ExposureTime"] ||
        exifRaw["FNumber"] ||
        exifRaw["ISO"],
    );

  // ------------------------------------------------------------
  // C2PA / CONTENT CREDENTIALS
  // ------------------------------------------------------------

  const scanWindow =
    bytes.length > 400_000
      ? bytes.slice(
          0,
          400_000,
        )
      : bytes;

  const asciiHead =
    Array.from(scanWindow)
      .map((b) =>
        String.fromCharCode(b),
      )
      .join("");

  const c2paPresent =
    /c2pa|contentcredentials|jumbf/i.test(
      asciiHead,
    );

  // ------------------------------------------------------------
  // METADATA STATUS
  // ------------------------------------------------------------

  let metadataStatus:
    ForensicReport["metadataStatus"] =
    "UNKNOWN";

  let metadataStatusReason =
    "";

  const inconsistencies:
    string[] = [];

  if (
    dateTimeOriginal &&
    modifyDate &&
    new Date(modifyDate) <
      new Date(dateTimeOriginal)
  ) {
    inconsistencies.push(
      "Modification timestamp precedes the original capture timestamp.",
    );
  }

  if (
    software &&
    cameraIndicators &&
    /photoshop|gimp|affinity|canva|picsart/i.test(
      software,
    ) &&
    !modifyDate
  ) {
    inconsistencies.push(
      "Editing software tag present alongside camera tags without a modification timestamp.",
    );
  }

  if (
    exifKeyCount === 0
  ) {
    metadataStatus =
      "MISSING";

    metadataStatusReason =
      "No EXIF/XMP block was found. This is normal for screenshots, messaging-app downloads and social-media exports, and is NOT evidence of manipulation or AI generation.";
  } else if (
    inconsistencies.length >
    0
  ) {
    metadataStatus =
      "INCONSISTENT";

    metadataStatusReason =
      inconsistencies.join(
        " ",
      );
  } else if (
    cameraIndicators &&
    dateTimeOriginal
  ) {
    metadataStatus =
      "INTACT";

    metadataStatusReason =
      "A coherent metadata block including capture-device and capture-time fields was recovered.";
  } else {
    metadataStatus =
      "PARTIALLY_AVAILABLE";

    metadataStatusReason =
      "Some metadata fields were recovered but key capture fields are absent. Partial metadata is common after re-encoding and is treated as mild uncertainty only.";
  }

  // ------------------------------------------------------------
  // PIXEL ANALYSIS
  // ------------------------------------------------------------

  const imageStats =
    computePixelStats(
      format,
      bytes,
    );

  // ------------------------------------------------------------
  // SIGNAL NORMALISATION
  // ------------------------------------------------------------

  const resKey =
    width && height
      ? `${width}x${height}`
      : "";

  const generatorResolutionMatch =
    GENERATOR_RESOLUTIONS.has(
      resKey,
    );

  const generatorTag =
    software
      ? containsAny(
          software,
          GENERATIVE_TOOL_PATTERNS,
        )
      : null;

  const editorTag =
    software
      ? containsAny(
          software,
          HEAVY_EDITOR_PATTERNS,
        )
      : null;

  const noise =
    imageStats.noiseFloor;

  const lowNoiseNorm =
    noise === undefined
      ? 0
      : noise >= 4
        ? 0
        : noise <= 0.6
          ? 1
          : round2(
              (4 - noise) /
                3.4,
            );

  const stdDev =
    imageStats.luminanceStdDev;

  const uniformNorm =
    stdDev === undefined
      ? 0
      : stdDev >= 40
        ? 0
        : stdDev <= 8
          ? 1
          : round2(
              (40 - stdDev) /
                32,
            );

  const noiseIrr =
    imageStats.noiseIrregularity;

  const uniformNoiseNorm =
    noiseIrr === undefined
      ? 0
      : noiseIrr >= 1.4
        ? 0
        : noiseIrr <= 0.5
          ? 1
          : round2(
              (1.4 - noiseIrr) /
                0.9,
            );

  const edgeUni =
    imageStats.edgeUniformity;

  const edgeUniformNorm =
    edgeUni === undefined
      ? 0
      : edgeUni <= 0.45
        ? 0
        : edgeUni >= 0.85
          ? 1
          : round2(
              (edgeUni - 0.45) /
                0.4,
            );

  const entropy =
    imageStats.colorEntropy;

  const lowEntropyNorm =
    entropy === undefined
      ? 0
      : entropy >= 0.72
        ? 0
        : entropy <= 0.4
          ? 1
          : round2(
              (0.72 - entropy) /
                0.32,
            );

  const period =
    imageStats.periodicity;

  const periodicNorm =
    period === undefined
      ? 0
      : period <= 0.35
        ? 0
        : period >= 0.8
          ? 1
          : round2(
              (period - 0.35) /
                0.45,
            );

  const metadataVacuum =
    !cameraIndicators &&
    !software;

  const smoothPixelEvidence =
    round2(
      Math.max(
        lowNoiseNorm,
        uniformNoiseNorm,
        edgeUniformNorm,
      ),
    );

  const vacuumSmoothNorm =
    metadataVacuum &&
    imageStats.available
      ? smoothPixelEvidence
      : 0;

  const quality =
    jpegStruct.estimatedQuality;

  const recompressionNorm =
    quality === undefined
      ? 0
      : quality < 70
        ? Math.min(
            1,
            (70 - quality) /
              40,
          )
        : quality > 97 &&
            editorTag
          ? 0.5
          : 0;

  const subsampling =
    jpegStruct.chromaSubsampling;

  const chromaMismatchNorm =
    subsampling &&
    cameraIndicators &&
    subsampling === "4:4:4"
      ? 1
      : 0;

  const dimsCameraLike =
    width && height
      ? width * height >
          1_500_000 &&
        !generatorResolutionMatch &&
        width !== height
      : false;

  // ------------------------------------------------------------
  // AI CONTRIBUTIONS
  // ------------------------------------------------------------

  const aiContribs = [
    {
      signal:
        "Generative-tool software signature",
      weight:
        SCORING_WEIGHTS.ai
          .generatorSoftwareTag,
      normalized:
        generatorTag
          ? 1
          : 0,
    },

    {
      signal:
        "C2PA content credentials indicating generative origin",
      weight:
        SCORING_WEIGHTS.ai
          .c2paGenerativeCredential,
      normalized:
        c2paPresent &&
        generatorTag
          ? 1
          : 0,
    },

    {
      signal:
        "Dimensions match a known generator default",
      weight:
        SCORING_WEIGHTS.ai
          .commonGeneratorResolution,
      normalized:
        generatorResolutionMatch
          ? 1
          : 0,
    },

    {
      signal:
        "Low high-frequency noise floor",
      weight:
        SCORING_WEIGHTS.ai
          .lowNoiseFloor,
      normalized:
        lowNoiseNorm,
    },

    {
      signal:
        "Spatially uniform noise texture",
      weight:
        SCORING_WEIGHTS.ai
          .uniformNoiseTexture,
      normalized:
        uniformNoiseNorm,
    },

    {
      signal:
        "Unnaturally uniform edge-energy distribution",
      weight:
        SCORING_WEIGHTS.ai
          .edgeEnergyUniformity,
      normalized:
        edgeUniformNorm,
    },

    {
      signal:
        "Low colour histogram entropy",
      weight:
        SCORING_WEIGHTS.ai
          .lowColorEntropy,
      normalized:
        lowEntropyNorm,
    },

    {
      signal:
        "Periodic / repeating pattern structure",
      weight:
        SCORING_WEIGHTS.ai
          .periodicPattern,
      normalized:
        periodicNorm,
    },

    {
      signal:
        "Unusually uniform luminance distribution",
      weight:
        SCORING_WEIGHTS.ai
          .uniformLuminance,
      normalized:
        uniformNorm,
    },

    {
      signal:
        "No camera metadata and no editor tag combined with smooth pixel statistics",
      weight:
        SCORING_WEIGHTS.ai
          .metadataVacuumWithSmoothPixels,
      normalized:
        vacuumSmoothNorm,
    },

    {
      signal:
        "No camera indicators combined with a tooling software tag",
      weight:
        SCORING_WEIGHTS.ai
          .noCameraIndicatorsWithSoftware,
      normalized:
        !cameraIndicators &&
        software
          ? 1
          : 0,
    },
  ];

  // ------------------------------------------------------------
  // MANIPULATION CONTRIBUTIONS
  // ------------------------------------------------------------

  const manipContribs = [
    {
      signal:
        "Metadata internally inconsistent",
      weight:
        SCORING_WEIGHTS
          .manipulation
          .metadataInconsistency,
      normalized:
        metadataStatus ===
        "INCONSISTENT"
          ? 1
          : 0,
    },

    {
      signal:
        "Recompression / quantisation anomaly",
      weight:
        SCORING_WEIGHTS
          .manipulation
          .recompressionAnomaly,
      normalized:
        recompressionNorm,
    },

    {
      signal:
        "Chroma subsampling inconsistent with claimed capture pipeline",
      weight:
        SCORING_WEIGHTS
          .manipulation
          .chromaSubsamplingMismatch,
      normalized:
        chromaMismatchNorm,
    },

    {
      signal:
        "Heavy-editor software signature",
      weight:
        SCORING_WEIGHTS
          .manipulation
          .heavyEditorSoftwareTag,
      normalized:
        editorTag ? 1 : 0,
    },

    {
      signal:
        "Dimensions not consistent with direct camera capture",
      weight:
        SCORING_WEIGHTS
          .manipulation
          .dimensionsNotCameraLike,
      normalized:
        dimsCameraLike
          ? 0
          : 0.5,
    },
  ];

  const signalBreakdown = [
    ...aiContribs.map((c) => ({
      ...c,
      contribution:
        round2(
          c.weight *
            c.normalized,
        ),
      scope:
        "ai" as const,
    })),

    ...manipContribs.map((c) => ({
      ...c,
      contribution:
        round2(
          c.weight *
            c.normalized,
        ),
      scope:
        "manipulation" as const,
    })),
  ];

  const clamp = (
    v: number,
  ) =>
    Math.max(
      0,
      Math.min(
        100,
        Math.round(v),
      ),
    );

  const aiProbability =
    clamp(
      aiContribs.reduce(
        (a, c) =>
          a +
          c.weight *
            c.normalized,
        0,
      ),
    );

  const manipulationProbability =
    clamp(
      manipContribs.reduce(
        (a, c) =>
          a +
          c.weight *
            c.normalized,
        0,
      ),
    );

  // ------------------------------------------------------------
  // EVIDENCE SIGNAL LIST
  // ------------------------------------------------------------

  const signals: EvidenceSignal[] =
    [];

  signals.push({
    key: "format",

    label:
      "Container format verified from byte header",

    value: format,

    status:
      format === "UNKNOWN"
        ? "inconsistent"
        : "supportive",

    detail: `Magic-number inspection of the first bytes reported ${format} (${mime}).`,
  });

  signals.push({
    key: "camera",

    label:
      "Camera metadata",

    value:
      cameraIndicators
        ? `${make ?? "Unknown make"} ${model ?? ""}`.trim()
        : "Not present",

    status:
      cameraIndicators
        ? "supportive"
        : "unavailable",

    detail:
      cameraIndicators
        ? "Capture-device tags were recovered from the EXIF block."
        : "No capture-device tags were recovered. Absence of metadata is not itself an indicator of manipulation.",
  });

  signals.push({
    key: "software",

    label:
      "Processing software tag",

    value:
      software ??
      "Not present",

    status:
      generatorTag
        ? "inconsistent"
        : editorTag
          ? "inconsistent"
          : software
            ? "supportive"
            : "unavailable",

    detail:
      generatorTag
        ? `The software tag matches a known generative-image tool signature ("${generatorTag}").`
        : editorTag
          ? `The software tag matches a known image-editing application ("${editorTag}"). Editing is not, by itself, manipulation of content.`
          : software
            ? "A software tag is present and does not match known generative or heavy-editing signatures."
            : "No software or creator-tool tag was recorded.",
  });

  signals.push({
    key: "dimensions",

    label:
      "Pixel dimensions",

    value:
      width && height
        ? `${width} × ${height}`
        : "Unavailable",

    status:
      generatorResolutionMatch
        ? "inconsistent"
        : width
          ? "supportive"
          : "unavailable",

    detail:
      generatorResolutionMatch
        ? "Dimensions match a resolution commonly emitted by generative-image tools. This is a weak signal and is never sufficient on its own."
        : "Dimensions do not match a known generator default resolution.",
  });

  signals.push({
    key: "noise",

    label:
      "High-frequency noise floor",

    value:
      noise === undefined
        ? "Unavailable"
        : String(noise),

    status:
      noise === undefined
        ? "unavailable"
        : lowNoiseNorm > 0.5
          ? "inconsistent"
          : "supportive",

    detail:
      noise === undefined
        ? imageStats.reason ??
          "Pixel statistics could not be computed for this file type."
        : lowNoiseNorm > 0.5
          ? "Neighbour-difference sampling indicates an unusually smooth image with little sensor-like noise."
          : "Neighbour-difference sampling indicates noise characteristics consistent with sensor capture or ordinary compression.",
  });

  signals.push({
    key: "luminance",

    label:
      "Luminance distribution",

    value:
      stdDev === undefined
        ? "Unavailable"
        : `mean ${imageStats.luminanceMean}, σ ${stdDev}`,

    status:
      stdDev === undefined
        ? "unavailable"
        : uniformNorm > 0.6
          ? "inconsistent"
          : "supportive",

    detail:
      stdDev === undefined
        ? "Pixel statistics unavailable for this file."
        : uniformNorm > 0.6
          ? "Tonal variance is unusually low across the sampled grid."
          : "Tonal variance is within the range expected for natural scene content.",
  });

  signals.push({
    key: "noiseTexture",

    label:
      "Noise texture irregularity",

    value:
      imageStats.noiseIrregularity ===
      undefined
        ? "Unavailable"
        : String(
            imageStats.noiseIrregularity,
          ),

    status:
      imageStats.noiseIrregularity ===
      undefined
        ? "unavailable"
        : uniformNoiseNorm > 0.5
          ? "inconsistent"
          : "supportive",

    detail:
      imageStats.noiseIrregularity ===
      undefined
        ? imageStats.reason ??
          "Block-variance statistics could not be computed."
        : uniformNoiseNorm > 0.5
          ? "Local variance is distributed unusually evenly across the frame. Sensor noise is normally texture-correlated and irregular; spatial uniformity is characteristic of generated or heavily denoised output."
          : "Local variance differs substantially between regions, consistent with texture-correlated sensor noise.",
  });

  signals.push({
    key: "edges",

    label:
      "High-frequency (edge) energy distribution",

    value:
      imageStats.edgeUniformity ===
      undefined
        ? "Unavailable"
        : `mean ${imageStats.edgeEnergyMean}, uniformity ${imageStats.edgeUniformity}`,

    status:
      imageStats.edgeUniformity ===
      undefined
        ? "unavailable"
        : edgeUniformNorm > 0.5
          ? "inconsistent"
          : "supportive",

    detail:
      imageStats.edgeUniformity ===
      undefined
        ? imageStats.reason ??
          "Sobel edge analysis could not be computed."
        : edgeUniformNorm > 0.5
          ? "A Sobel pass shows high-frequency energy spread almost identically across the frame, a pattern associated with upsampling and synthesised detail."
          : "A Sobel pass shows edge energy concentrated around scene structure, as expected for photographic content.",
  });

  signals.push({
    key: "entropy",

    label:
      "Colour histogram entropy",

    value:
      imageStats.colorEntropy ===
      undefined
        ? "Unavailable"
        : String(
            imageStats.colorEntropy,
          ),

    status:
      imageStats.colorEntropy ===
      undefined
        ? "unavailable"
        : lowEntropyNorm > 0.5
          ? "inconsistent"
          : "supportive",

    detail:
      imageStats.colorEntropy ===
      undefined
        ? imageStats.reason ??
          "Histogram statistics could not be computed."
        : lowEntropyNorm > 0.5
          ? "Per-channel histogram entropy is low, indicating an unusually smooth or restricted palette."
          : "Per-channel histogram entropy is within the broad range expected for natural scene content.",
  });

  signals.push({
    key: "periodicity",

    label:
      "Repeating-pattern (autocorrelation) check",

    value:
      imageStats.periodicity ===
      undefined
        ? "Unavailable"
        : String(
            imageStats.periodicity,
          ),

    status:
      imageStats.periodicity ===
      undefined
        ? "unavailable"
        : periodicNorm > 0.5
          ? "inconsistent"
          : "supportive",

    detail:
      imageStats.periodicity ===
      undefined
        ? imageStats.reason ??
          "Autocorrelation could not be computed."
        : periodicNorm > 0.5
          ? "Row/column autocorrelation peaks at short lags, indicating periodic tiling structure rather than natural scene variation."
          : "No strong short-lag periodicity was detected in the row or column profiles.",
  });

  if (
    jpegStruct.estimatedQuality !==
    undefined
  ) {
    signals.push({
      key: "quantization",

      label:
        "JPEG quantisation characteristics",

      value: `est. quality ${jpegStruct.estimatedQuality} (Σ table ${jpegStruct.quantizationSum})`,

      status:
        recompressionNorm > 0.4
          ? "inconsistent"
          : "supportive",

      detail:
        recompressionNorm > 0.4
          ? "Quantisation-table magnitude indicates aggressive or repeated re-encoding of this image."
          : "Quantisation-table magnitude is consistent with a single encoding pass at normal quality.",
    });
  }

  if (subsampling) {
    signals.push({
      key: "chroma",

      label:
        "Chroma subsampling",

      value: subsampling,

      status:
        chromaMismatchNorm
          ? "inconsistent"
          : "supportive",

      detail:
        chromaMismatchNorm
          ? "Subsampling mode differs from the default used by most camera encoding pipelines that would have written the present metadata. Weak corroborating signal only."
          : "Subsampling mode is consistent with common capture and export pipelines.",
    });
  }

  signals.push({
    key: "c2pa",

    label:
      "C2PA / Content Credentials",

    value:
      c2paPresent
        ? "Present"
        : "Not detected",

    status:
      c2paPresent
        ? "supportive"
        : "unavailable",

    detail:
      c2paPresent
        ? "A content-credentials/JUMBF structure was detected in the file. This is a real provenance standard and is weighted strongly."
        : "No content-credentials structure was detected. Most files in circulation carry none.",
  });

  signals.push({
    key: "gps",

    label:
      "Geolocation tags",

    value:
      gpsPresent
        ? "Present (coordinates withheld)"
        : "Not present",

    status:
      gpsPresent
        ? "supportive"
        : "unavailable",

    detail:
      gpsPresent
        ? "Geolocation fields exist in the metadata. Precise coordinates are deliberately not displayed in this prototype."
        : "No geolocation fields were recorded.",
  });

  const availableSignalCount =
    signals.filter(
      (s) =>
        s.status !==
        "unavailable",
    ).length;

  // ------------------------------------------------------------
  // AUTHENTICITY CONFIDENCE
  // ------------------------------------------------------------

  const categories: {
    key: string;
    available: boolean;
    direction:
      | "authentic"
      | "suspicious"
      | "neutral";
  }[] = [
    {
      key: "metadata",

      available:
        exifKeyCount > 0,

      direction:
        metadataStatus ===
        "INCONSISTENT"
          ? "suspicious"
          : cameraIndicators
            ? "authentic"
            : "neutral",
    },

    {
      key: "software",

      available:
        Boolean(software),

      direction:
        generatorTag ||
        editorTag
          ? "suspicious"
          : software
            ? "authentic"
            : "neutral",
    },

    {
      key: "noise-floor",

      available:
        imageStats.noiseFloor !==
        undefined,

      direction:
        lowNoiseNorm > 0.5
          ? "suspicious"
          : lowNoiseNorm < 0.2
            ? "authentic"
            : "neutral",
    },

    {
      key: "noise-texture",

      available:
        imageStats.noiseIrregularity !==
        undefined,

      direction:
        uniformNoiseNorm > 0.5
          ? "suspicious"
          : uniformNoiseNorm < 0.2
            ? "authentic"
            : "neutral",
    },

    {
      key: "edge-energy",

      available:
        imageStats.edgeUniformity !==
        undefined,

      direction:
        edgeUniformNorm > 0.5
          ? "suspicious"
          : edgeUniformNorm < 0.2
            ? "authentic"
            : "neutral",
    },

    {
      key: "colour-entropy",

      available:
        imageStats.colorEntropy !==
        undefined,

      direction:
        lowEntropyNorm > 0.5
          ? "suspicious"
          : lowEntropyNorm < 0.2
            ? "authentic"
            : "neutral",
    },

    {
      key: "periodicity",

      available:
        imageStats.periodicity !==
        undefined,

      direction:
        periodicNorm > 0.5
          ? "suspicious"
          : periodicNorm < 0.2
            ? "authentic"
            : "neutral",
    },

    {
      key: "compression",

      available:
        jpegStruct.estimatedQuality !==
        undefined,

      direction:
        recompressionNorm > 0.4
          ? "suspicious"
          : "authentic",
    },

    {
      key: "c2pa",

      available:
        c2paPresent,

      direction:
        "authentic",
    },
  ];

  const availableCategories =
    categories.filter(
      (c) => c.available,
    );

  const categoriesAvailable =
    availableCategories.length;

  const directional =
    availableCategories.filter(
      (c) =>
        c.direction !==
        "neutral",
    );

  const suspicious =
    directional.filter(
      (c) =>
        c.direction ===
        "suspicious",
    ).length;

  const authenticLeaning =
    directional.length -
    suspicious;

  const agreement =
    directional.length === 0
      ? 0
      : round2(
          Math.abs(
            authenticLeaning -
              suspicious,
          ) /
            directional.length,
        );

  const evidenceStrength =
    Math.min(
      1,
      categoriesAvailable /
        6,
    );

  let authenticityConfidence =
    clamp(
      20 +
        evidenceStrength *
          50 +
        agreement * 30,
    );

  let confidenceStatus:
    ForensicReport["confidenceStatus"] =
    "SUFFICIENT";

  let confidenceReason =
    agreement >= 0.7
      ? `${categoriesAvailable} independent signal categories were available and were largely consistent with one another.`
      : `${categoriesAvailable} independent signal categories were available but they conflicted with one another, which lowers assessment confidence.`;

  if (
    !imageStats.available ||
    categoriesAvailable < 3
  ) {
    confidenceStatus =
      "INSUFFICIENT_EVIDENCE";

    authenticityConfidence =
      Math.min(
        authenticityConfidence,
        30,
      );

    confidenceReason =
      !imageStats.available
        ? `Pixel-level analysis could not be completed for this file (${imageStats.reason ?? "decode failure"}), so too few independent signals were computed to report a confidence figure.`
        : "Fewer than three independent signal categories could be computed for this file; treat this assessment as preliminary rather than conclusive.";
  }

  // ------------------------------------------------------------
  // RISK LEVEL
  // ------------------------------------------------------------

  const combined =
    Math.max(
      aiProbability,
      manipulationProbability,
    ) *
      0.7 +
    Math.min(
      aiProbability,
      manipulationProbability,
    ) *
      0.3;

  const riskLevel:
    ForensicReport["riskLevel"] =
    combined >= 75
      ? "CRITICAL"
      : combined >= 50
        ? "HIGH"
        : combined >= 25
          ? "MODERATE"
          : "LOW";

  // ------------------------------------------------------------
  // FINDINGS
  // ------------------------------------------------------------

  const findings: Finding[] =
    [];

  const push = (
    f: Finding,
  ) =>
    findings.push(f);

  if (cameraIndicators) {
    push({
      id: "camera-metadata",

      title:
        "Camera metadata detected",

      severity:
        "INFORMATIONAL",

      confidence: 85,

      signalType:
        "EXIF / capture device",

      explanation: `Capture-device fields were recovered (${[
        make,
        model,
      ]
        .filter(Boolean)
        .join(" ") || "device fields present"}), which is consistent with an image originating from a physical camera pipeline.`,
    });
  } else {
    push({
      id: "no-camera-metadata",

      title:
        "No capture-device metadata recovered",

      severity: "LOW",

      confidence: 60,

      signalType:
        "EXIF / capture device",

      explanation:
        "No camera make, model or exposure fields were recovered. This routinely occurs with screenshots, messaging-app downloads and social-media exports and is recorded as uncertainty, not as an indicator of manipulation.",
    });
  }

  if (generatorTag) {
    push({
      id: "generative-tag",

      title:
        "Generative-tool software signature detected",

      severity: "HIGH",

      confidence: 90,

      signalType:
        "Software tag matching",

      explanation: `The recorded software/creator-tool field ("${software}") matches a known generative-image tool signature. This is the strongest available indicator of synthetic origin in this engine.`,
    });
  }

  if (editorTag) {
    push({
      id: "editor-tag",

      title:
        "Image-editing software signature detected",

      severity: "MODERATE",

      confidence: 80,

      signalType:
        "Software tag matching",

      explanation: `The recorded software field ("${software}") corresponds to a known image-editing application. Editing may be entirely legitimate (cropping, colour correction) and does not by itself establish content manipulation.`,
    });
  }

  if (
    metadataStatus ===
    "INCONSISTENT"
  ) {
    push({
      id: "metadata-inconsistent",

      title:
        "Metadata timeline internally inconsistent",

      severity: "HIGH",

      confidence: 75,

      signalType:
        "Metadata consistency",

      explanation:
        metadataStatusReason,
    });
  }

  if (
    metadataStatus ===
      "MISSING" ||
    metadataStatus ===
      "PARTIALLY_AVAILABLE"
  ) {
    push({
      id: "metadata-incomplete",

      title:
        "Metadata appears incomplete",

      severity: "LOW",

      confidence: 70,

      signalType:
        "Metadata availability",

      explanation:
        metadataStatusReason,
    });
  }

  if (
    recompressionNorm > 0.4
  ) {
    push({
      id: "recompression",

      title:
        "Compression characteristics indicate recompression",

      severity: "MODERATE",

      confidence: 65,

      signalType:
        "JPEG quantisation analysis",

      explanation: `Quantisation tables imply an estimated encoder quality of ${jpegStruct.estimatedQuality}, consistent with the file having been re-encoded one or more times after original capture.`,
    });
  }

  if (
    lowNoiseNorm > 0.5
  ) {
    push({
      id: "low-noise",

      title:
        "Unusually low high-frequency noise floor",

      severity: "MODERATE",

      confidence: 60,

      signalType:
        "Pixel statistics",

      explanation: `The sampled neighbour-difference noise estimate is ${noise}, below the range typically produced by sensor capture. Heavy denoising and several synthetic-image pipelines both produce this characteristic, so it is weighted as one input among several.`,
    });
  }

  if (
    uniformNoiseNorm > 0.5
  ) {
    push({
      id: "uniform-noise-texture",

      title:
        "Noise texture is spatially uniform",

      severity: "HIGH",

      confidence: 65,

      signalType:
        "Pixel statistics — block variance",

      explanation: `Variance measured across an 8x8 block lattice varies by only ${imageStats.noiseIrregularity} relative to its mean. Photographic sensor noise is texture-correlated and therefore irregular across a frame; near-uniform local variance is characteristic of generated or aggressively denoised imagery.`,
    });
  }

  if (
    edgeUniformNorm > 0.5
  ) {
    push({
      id: "uniform-edge-energy",

      title:
        "High-frequency energy distributed unnaturally evenly",

      severity: "MODERATE",

      confidence: 60,

      signalType:
        "Pixel statistics — Sobel edge energy",

      explanation: `A Sobel gradient pass gives a mean edge energy of ${imageStats.edgeEnergyMean} with a cross-block uniformity of ${imageStats.edgeUniformity}. Natural scenes concentrate high-frequency energy around subject boundaries; an even spread is associated with upsampled or synthesised detail.`,
    });
  }

  if (
    lowEntropyNorm > 0.5
  ) {
    push({
      id: "low-colour-entropy",

      title:
        "Colour histogram entropy is low",

      severity: "MODERATE",

      confidence: 55,

      signalType:
        "Pixel statistics — histogram entropy",

      explanation: `Mean normalised per-channel histogram entropy is ${imageStats.colorEntropy}. Smooth gradients and restricted palettes lower this figure; some legitimate imagery (studio backdrops, graphics) does the same, so this is one input among several.`,
    });
  }

  if (
    periodicNorm > 0.5
  ) {
    push({
      id: "periodic-structure",

      title:
        "Periodic pattern structure detected",

      severity: "MODERATE",

      confidence: 55,

      signalType:
        "Pixel statistics — autocorrelation",

      explanation: `The strongest short-lag autocorrelation peak is ${imageStats.periodicity}, indicating repeating structure at small pixel offsets. This is typical of tiling or upsampling artefacts, though repetitive real-world subjects can also produce it.`,
    });
  }

  if (
    metadataVacuum &&
    smoothPixelEvidence > 0.5
  ) {
    push({
      id:
        "metadata-vacuum-smooth-pixels",

      title:
        "No provenance metadata combined with smooth pixel statistics",

      severity: "MODERATE",

      confidence: 60,

      signalType:
        "Combined-absence analysis",

      explanation:
        "This file carries neither capture-device metadata nor an editing-software tag, and its decoded pixel statistics are smoother and more uniform than sensor capture normally produces. Absent metadata alone is never treated as suspicious; it is the combination with the pixel evidence that is scored here.",
    });
  }

  if (
    generatorResolutionMatch
  ) {
    push({
      id:
        "generator-resolution",

      title:
        "Dimensions match a common generator default",

      severity: "LOW",

      confidence: 45,

      signalType:
        "Dimension heuristics",

      explanation: `The image measures ${resKey}, a resolution commonly emitted by generative-image tools. Many legitimate images share these dimensions, so this signal is weak and never decisive.`,
    });
  } else if (
    dimsCameraLike
  ) {
    push({
      id:
        "camera-like-dimensions",

      title:
        "Dimensions consistent with common device capture",

      severity:
        "INFORMATIONAL",

      confidence: 50,

      signalType:
        "Dimension heuristics",

      explanation: `The image measures ${resKey}, which is consistent with typical smartphone or camera capture rather than a generator default.`,
    });
  }

  if (c2paPresent) {
    push({
      id: "c2pa",

      title:
        "Content credentials structure present",

      severity:
        "INFORMATIONAL",

      confidence: 80,

      signalType:
        "C2PA provenance",

      explanation:
        "A C2PA/JUMBF provenance structure was found embedded in the file. Content credentials are a real provenance standard and are weighted strongly in whichever direction their contents point.",
    });
  }

  if (!imageStats.available) {
    push({
      id:
        "pixel-unavailable",

      title:
        "Pixel-level analysis unavailable",

      severity: "LOW",

      confidence: 40,

      signalType:
        "Decoding",

      explanation:
        imageStats.reason ??
        "The image could not be decoded for pixel-level analysis.",
    });
  }

  // ------------------------------------------------------------
  // SUMMARY
  // ------------------------------------------------------------

  const summary = [
    `Evidence file "${declaredName}" was verified as ${format} from its byte header and fingerprinted as SHA-256 ${fileHash.slice(0, 16)}….`,

    `Heuristic assessment returns an AI-generation likelihood of ${aiProbability} (${band(aiProbability)}) and a manipulation likelihood of ${manipulationProbability} (${band(manipulationProbability)}), giving an overall risk banding of ${riskLevel}.`,

    `Metadata status: ${metadataStatus.replace("_", " ")}. ${metadataStatusReason}`,

    confidenceReason,
  ].join(" ");

  const ar =
    width && height
      ? (() => {
          const g =
            gcd(
              width,
              height,
            );

          return `${width / g}:${height / g}`;
        })()
      : null;

  // ------------------------------------------------------------
  // FINAL FORENSIC REPORT
  // ------------------------------------------------------------

  return {
    engineVersion:
      ENGINE_VERSION,

    fileHash,

    file: {
      detectedFormat:
        format,

      detectedMime:
        mime,

      byteSize:
        bytes.length,

      width,

      height,

      aspectRatio:
        ar,
    },

    exif: {
      Make: make,

      Model: model,

      LensModel: lens,

      Software: software,

      DateTimeOriginal:
        dateTimeOriginal,

      ModifyDate:
        modifyDate,

      Orientation:
        orientation,

      ColorSpace:
        colorSpace,

      GPSPresent:
        gpsPresent,

      TagCount:
        exifKeyCount,
    },

    metadataStatus,

    metadataStatusReason,

    imageStats,

    jpeg: {
      isJpeg:
        format === "JPEG",

      quantizationSum:
        jpegStruct.quantizationSum,

      estimatedQuality:
        jpegStruct.estimatedQuality,

      chromaSubsampling:
        jpegStruct.chromaSubsampling,
    },

    c2paPresent,

    signals,

    signalBreakdown,

    findings,

    aiProbability,

    manipulationProbability,

    authenticityConfidence,

    confidenceStatus,

    confidenceReason,

    riskLevel,

    aiBand:
      band(aiProbability),

    manipulationBand:
      band(
        manipulationProbability,
      ),

    summary,

    availableSignalCount,

    regional:
      imageStats.regional ??
      {
        available: false,

        gridWidth: 0,

        gridHeight: 0,

        tileSize: 0,

        tiles: [],

        strongTileRatio: 0,

        meanScore: 0,

        maxScore: 0,

        summary:
          imageStats.reason ??
          "Regional pixel analysis was unavailable for this image.",
      },
  };
}