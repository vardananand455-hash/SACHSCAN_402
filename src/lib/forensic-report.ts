/** Client-side view model for the report JSON stored in analysis_results.signals. */

export interface StoredSignal {
  key: string;
  label: string;
  value: string;
  status: "supportive" | "inconsistent" | "unavailable";
  detail: string;
}

export interface StoredFinding {
  id: string;
  title: string;
  severity: "INFORMATIONAL" | "LOW" | "MODERATE" | "HIGH";
  confidence: number;
  signalType: string;
  explanation: string;
}

export interface StoredRegionTile {
  cx: number;
  cy: number;
  x: number;
  y: number;
  w: number;
  h: number;
  intensity: number;
  metrics: { noise: number; texture: number; edge: number; blockiness: number };
  deviations: { noise: number; texture: number; edge: number; blockiness: number };
}

export interface StoredRegionalMap {
  version: number;
  available: boolean;
  reason?: string;
  cols: number;
  rows: number;
  sourceWidth: number;
  sourceHeight: number;
  gridWidth: number;
  gridHeight: number;
  tiles: StoredRegionTile[];
  baseline: { noise: number; texture: number; edge: number; blockiness: number };
  strongTileRatio: number;
  peakIntensity: number;
  summary: string;
}

export interface StoredTextStats {
  wordCount: number;
  characterCount: number;
  sentenceCount: number;
  paragraphCount: number;
  meanSentenceWords: number;
  sentenceLengthStdDev: number;
  sentenceLengthCv: number;
  typeTokenRatio: number;
  windowedTypeTokenRatio: number;
  repeatedNgramRatio: number;
  distinctPunctuation: number;
  punctuationPerSentence: number;
  paragraphLengthCv: number | null;
  transitionalPhraseRate: number;
  commonWordShare: number;
  longestRepeatedPhrase: string | null;
}

export interface StoredVideoAnalysis {
  container: {
    durationSeconds: number;
    analysedSeconds: number;
    width: number;
    height: number;
    truncated: boolean;
  };
  frames: {
    index: number;
    timestamp: number;
    aiScore: number;
    noiseFloor: number | null;
    edgeEnergy: number | null;
    colorEntropy: number | null;
    available: boolean;
    topSignal: string | null;
  }[];
  crossFrame: {
    noiseCv: number;
    edgeCv: number;
    entropyCv: number;
    scoreSpread: number;
    uniformityNormalized: number;
    outlierFrames: number;
  };
}

export interface StoredReport {
  /** Present on records produced by the text and video engines. */
  mediaKind?: "image" | "text" | "video";
  /** Text evidence only. */
  textStats?: StoredTextStats;
  excerpt?: string;
  /** Video evidence only. */
  video?: StoredVideoAnalysis;
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
  metadataStatus: string;
  metadataStatusReason: string;
  imageStats: {
    available: boolean;
    reason?: string;
    luminanceMean?: number;
    luminanceStdDev?: number;
    noiseFloor?: number;
    sampledPixels?: number;
  };
  jpeg: {
    isJpeg: boolean;
    quantizationSum?: number;
    estimatedQuality?: number;
    chromaSubsampling?: string;
  };
  c2paPresent: boolean;
  signals: StoredSignal[];
  signalBreakdown: { signal: string; weight: number; normalized: number; contribution: number; scope: "ai" | "manipulation" }[];
  findings: StoredFinding[];
  aiProbability: number;
  manipulationProbability: number;
  authenticityConfidence: number;
  confidenceStatus: "SUFFICIENT" | "INSUFFICIENT_EVIDENCE";
  confidenceReason: string;
  riskLevel: string;
  aiBand: string;
  manipulationBand: string;
  summary: string;
  availableSignalCount: number;
  /** Persisted regional forensic signal map (heatmap source of truth). */
  regional?: StoredRegionalMap;
  /** Real AI-generation detection result from the backend provider. */
  aiDetection?: {
    provider: string;
    aiProbability: number;
    rawScore: number;
    mediaKind: "image" | "video";
    topGeneratorLabel: string | null;
    topGenerator: { name: string; score: number } | null;
    generators: { name: string; score: number }[];
  };
}

export function asReport(signals: unknown): StoredReport | null {
  if (!signals || typeof signals !== "object") return null;
  const r = signals as Partial<StoredReport>;
  if (!r.file || !Array.isArray(r.signals)) return null;
  return r as StoredReport;
}
