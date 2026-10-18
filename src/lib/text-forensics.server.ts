/**
 * Deterministic linguistic forensic engine for TEXT evidence (server-only).
 *
 * Absolutely no randomness: every score is a pure function of the submitted
 * characters. The same text always produces byte-identical output. This is a
 * heuristic engine — it is NOT a trained classifier, and the UI states so.
 */

export const TEXT_ENGINE_VERSION = 1;
export const TEXT_MIN_WORDS = 50;

export interface TextSignal {
  key: string;
  label: string;
  value: string;
  status: "supportive" | "inconsistent" | "unavailable";
  detail: string;
}

export interface TextFinding {
  id: string;
  title: string;
  severity: "INFORMATIONAL" | "LOW" | "MODERATE" | "HIGH";
  confidence: number;
  signalType: string;
  explanation: string;
}

export interface TextStats {
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

export interface TextReport {
  engineVersion: number;
  fileHash: string;
  mediaKind: "text";
  file: {
    detectedFormat: string;
    detectedMime: string;
    byteSize: number;
    width: null;
    height: null;
    aspectRatio: null;
  };
  exif: Record<string, string | number | boolean | null>;
  metadataStatus: "INTACT" | "PARTIALLY_AVAILABLE" | "MISSING" | "INCONSISTENT" | "UNKNOWN";
  metadataStatusReason: string;
  imageStats: { available: false; reason: string };
  jpeg: { isJpeg: false };
  c2paPresent: false;
  textStats: TextStats;
  excerpt: string;
  signals: TextSignal[];
  signalBreakdown: { signal: string; weight: number; normalized: number; contribution: number; scope: "ai" | "manipulation" }[];
  findings: TextFinding[];
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
}

/** Documented weighted-sum model. Weights are maximum points on a 0-100 scale. */
export const TEXT_SCORING_WEIGHTS = {
  sentenceLengthUniformity: 22,
  vocabularyDiversity: 18,
  repeatedPhrasing: 16,
  transitionalPhraseDensity: 12,
  predictabilityProxy: 12,
  punctuationVariety: 10,
  paragraphUniformity: 10,
} as const;

const TRANSITIONS = [
  "however",
  "moreover",
  "furthermore",
  "in addition",
  "additionally",
  "therefore",
  "thus",
  "consequently",
  "as a result",
  "in conclusion",
  "overall",
  "in summary",
  "for instance",
  "for example",
  "on the other hand",
  "in contrast",
  "notably",
  "importantly",
  "ultimately",
  "it is important to note",
  "in today's world",
  "delve into",
  "furthermore,",
];

/** Frequency-ranked common English words — a weak predictability proxy only. */
const COMMON_WORDS = new Set(
  (
    "the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were has had said very much many those such should our own"
  )
    .split(/\s+/)
    .filter(Boolean),
);

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
function band(score: number): string {
  if (score <= 20) return "Low";
  if (score <= 40) return "Mild";
  if (score <= 60) return "Moderate";
  if (score <= 80) return "High";
  return "Very High";
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+(?=["'“(\[]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).filter(Boolean).length > 0);
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z''’-]+/g) ?? [];
}

function cv(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function computeStats(text: string): TextStats {
  const sentences = splitSentences(text);
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const tokens = words(text);
  const sentenceLengths = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  const mean = sentenceLengths.length ? sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length : 0;
  const variance = sentenceLengths.length
    ? sentenceLengths.reduce((a, b) => a + (b - mean) ** 2, 0) / sentenceLengths.length
    : 0;

  // Windowed type-token ratio: mean unique-word ratio over fixed 100-word
  // windows, which removes the length bias of a whole-text TTR.
  const windowSize = 100;
  const windowRatios: number[] = [];
  for (let i = 0; i + windowSize <= tokens.length; i += windowSize) {
    const slice = tokens.slice(i, i + windowSize);
    windowRatios.push(new Set(slice).size / slice.length);
  }
  if (!windowRatios.length && tokens.length) windowRatios.push(new Set(tokens).size / tokens.length);

  // Repeated 4-gram share and the longest repeated phrase.
  const n = 4;
  const counts = new Map<string, number>();
  for (let i = 0; i + n <= tokens.length; i++) counts.set(tokens.slice(i, i + n).join(" "), (counts.get(tokens.slice(i, i + n).join(" ")) ?? 0) + 1);
  let repeated = 0;
  let longest: string | null = null;
  let longestCount = 1;
  for (const [gram, c] of counts) {
    if (c > 1) {
      repeated += c - 1;
      if (c > longestCount || (c === longestCount && longest !== null && gram.length > longest.length)) {
        longest = gram;
        longestCount = c;
      }
    }
  }
  const totalGrams = Math.max(1, tokens.length - n + 1);

  const punctuationChars = text.match(/[,;:—–()"'!?…\-]/g) ?? [];
  const distinctPunctuation = new Set(punctuationChars.map((c) => (c === "–" ? "—" : c))).size;

  const lower = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  let transitions = 0;
  for (const phrase of TRANSITIONS) {
    const needle = phrase.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      transitions++;
      from = at + needle.length;
    }
  }

  const commonHits = tokens.filter((t) => COMMON_WORDS.has(t)).length;

  return {
    wordCount: tokens.length,
    characterCount: text.length,
    sentenceCount: sentences.length,
    paragraphCount: paragraphs.length,
    meanSentenceWords: round(mean),
    sentenceLengthStdDev: round(Math.sqrt(variance)),
    sentenceLengthCv: round(mean ? Math.sqrt(variance) / mean : 0, 3),
    typeTokenRatio: round(tokens.length ? new Set(tokens).size / tokens.length : 0, 3),
    windowedTypeTokenRatio: round(windowRatios.length ? windowRatios.reduce((a, b) => a + b, 0) / windowRatios.length : 0, 3),
    repeatedNgramRatio: round(repeated / totalGrams, 4),
    distinctPunctuation,
    punctuationPerSentence: round(sentences.length ? punctuationChars.length / sentences.length : 0),
    paragraphLengthCv: paragraphs.length >= 3 ? round(cv(paragraphs.map((p) => splitSentences(p).length)), 3) : null,
    transitionalPhraseRate: round(sentences.length ? transitions / sentences.length : 0, 3),
    commonWordShare: round(tokens.length ? commonHits / tokens.length : 0, 3),
    longestRepeatedPhrase: longest,
  };
}

interface Contribution {
  key: keyof typeof TEXT_SCORING_WEIGHTS;
  label: string;
  normalized: number;
  value: string;
  detail: string;
  supportive: boolean;
  available: boolean;
}

function buildContributions(s: TextStats): Contribution[] {
  const out: Contribution[] = [];

  // 1. Sentence-length burstiness. Human prose mixes short and long sentences;
  //    a very low coefficient of variation is unusually uniform.
  const cvSignal = s.sentenceCount >= 4;
  const cvNorm = clamp01((0.45 - s.sentenceLengthCv) / 0.35);
  out.push({
    key: "sentenceLengthUniformity",
    label: "Sentence-length uniformity",
    normalized: cvSignal ? cvNorm : 0,
    value: cvSignal ? `CV ${s.sentenceLengthCv} (mean ${s.meanSentenceWords} words, SD ${s.sentenceLengthStdDev})` : "Too few sentences",
    detail: cvSignal
      ? "Coefficient of variation of sentence length. Lower values mean less burstiness than typical human prose."
      : "At least four sentences are required to measure burstiness.",
    supportive: cvSignal && cvNorm >= 0.5,
    available: cvSignal,
  });

  // 2. Vocabulary diversity (windowed TTR).
  const ttrNorm = clamp01((0.72 - s.windowedTypeTokenRatio) / 0.25);
  out.push({
    key: "vocabularyDiversity",
    label: "Vocabulary diversity",
    normalized: ttrNorm,
    value: `Windowed TTR ${s.windowedTypeTokenRatio} (overall ${s.typeTokenRatio})`,
    detail: "Unique-word ratio measured over fixed 100-word windows; low diversity for the length is a weighted signal.",
    supportive: ttrNorm >= 0.5,
    available: true,
  });

  // 3. Repeated phrasing (4-gram repetition).
  const repNorm = clamp01(s.repeatedNgramRatio / 0.06);
  out.push({
    key: "repeatedPhrasing",
    label: "Repeated phrasing",
    normalized: repNorm,
    value: `${round(s.repeatedNgramRatio * 100, 2)}% of 4-grams repeat`,
    detail: s.longestRepeatedPhrase
      ? `Most repeated 4-gram: "${s.longestRepeatedPhrase}".`
      : "No 4-word sequence occurs more than once.",
    supportive: repNorm >= 0.5,
    available: true,
  });

  // 4. Transitional-phrase density.
  const transNorm = clamp01((s.transitionalPhraseRate - 0.1) / 0.25);
  out.push({
    key: "transitionalPhraseDensity",
    label: "Transitional-phrase density",
    normalized: transNorm,
    value: `${s.transitionalPhraseRate} per sentence`,
    detail: "Rate of discourse connectives ('however', 'moreover', 'in conclusion') per sentence.",
    supportive: transNorm >= 0.5,
    available: s.sentenceCount >= 3,
  });

  // 5. Predictability proxy (weak): share of high-frequency English words.
  const predNorm = clamp01((s.commonWordShare - 0.42) / 0.18);
  out.push({
    key: "predictabilityProxy",
    label: "Predictability proxy (weak)",
    normalized: predNorm,
    value: `${round(s.commonWordShare * 100, 1)}% high-frequency words`,
    detail:
      "Frequency-list proxy for lexical predictability. This is a weak heuristic and is NOT a language-model perplexity score.",
    supportive: predNorm >= 0.5,
    available: true,
  });

  // 6. Punctuation variety.
  const punctNorm = clamp01((4 - s.distinctPunctuation) / 3);
  out.push({
    key: "punctuationVariety",
    label: "Punctuation variety",
    normalized: punctNorm,
    value: `${s.distinctPunctuation} distinct marks, ${s.punctuationPerSentence} per sentence`,
    detail: "Narrow punctuation repertoire is a mild uniformity signal.",
    supportive: punctNorm >= 0.5,
    available: true,
  });

  // 7. Paragraph-length uniformity (only with 3+ paragraphs).
  const paraAvailable = s.paragraphLengthCv !== null;
  const paraNorm = paraAvailable ? clamp01((0.35 - (s.paragraphLengthCv as number)) / 0.3) : 0;
  out.push({
    key: "paragraphUniformity",
    label: "Paragraph-length uniformity",
    normalized: paraNorm,
    value: paraAvailable ? `CV ${s.paragraphLengthCv} across ${s.paragraphCount} paragraphs` : "Fewer than three paragraphs",
    detail: paraAvailable
      ? "Coefficient of variation of sentences per paragraph."
      : "Three or more paragraphs are required for this measurement.",
    supportive: paraAvailable && paraNorm >= 0.5,
    available: paraAvailable,
  });

  return out;
}

/** Runs the full deterministic text examination. */
export function analyzeText(
  text: string,
  fileHash: string,
  source: { fileName: string; declaredMime: string; byteSize: number; extractedFrom: string },
): TextReport {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const stats = computeStats(normalized);
  const contributions = buildContributions(stats);

  const insufficient = stats.wordCount < TEXT_MIN_WORDS;
  const signalBreakdown = contributions.map((c) => ({
    signal: c.key,
    weight: TEXT_SCORING_WEIGHTS[c.key],
    normalized: round(c.available ? c.normalized : 0, 3),
    contribution: round(c.available ? TEXT_SCORING_WEIGHTS[c.key] * c.normalized : 0, 2),
    scope: "ai" as const,
  }));

  const rawAi = signalBreakdown.reduce((a, b) => a + b.contribution, 0);
  const aiProbability = insufficient ? 0 : Math.max(0, Math.min(100, round(rawAi, 1)));

  const availableSignalCount = contributions.filter((c) => c.available).length;
  const firedCount = contributions.filter((c) => c.available && c.normalized >= 0.5).length;

  // Confidence: how much measurable evidence exists and how consistently the
  // available signals point in one direction.
  const coverage = availableSignalCount / contributions.length;
  const agreement =
    availableSignalCount > 0 ? Math.abs(firedCount / availableSignalCount - 0.5) * 2 : 0;
  const lengthFactor = clamp01((stats.wordCount - TEXT_MIN_WORDS) / 350);
  const authenticityConfidence = insufficient
    ? 0
    : Math.round(100 * clamp01(0.25 + 0.35 * coverage + 0.2 * agreement + 0.2 * lengthFactor));

  const signals: TextSignal[] = contributions.map((c) => ({
    key: c.key,
    label: c.label,
    value: c.value,
    status: !c.available ? "unavailable" : c.supportive ? "inconsistent" : "supportive",
    detail: c.detail,
  }));
  signals.push({
    key: "documentMetadata",
    label: "Document provenance metadata",
    value: `${source.extractedFrom} — ${source.fileName}`,
    status: "unavailable",
    detail:
      "Text evidence carries no capture-device metadata. Its absence is reported neutrally and is never treated as evidence of generation.",
  });

  const findings: TextFinding[] = contributions
    .filter((c) => c.available && c.normalized >= 0.35)
    .sort((a, b) => TEXT_SCORING_WEIGHTS[b.key] * b.normalized - TEXT_SCORING_WEIGHTS[a.key] * a.normalized)
    .map((c) => ({
      id: `text-${c.key}`,
      title: `${c.label}: ${c.value}`,
      severity: (c.normalized >= 0.75 ? "MODERATE" : c.normalized >= 0.5 ? "LOW" : "INFORMATIONAL") as TextFinding["severity"],
      confidence: Math.round(c.normalized * 100),
      signalType: "linguistic",
      explanation: c.detail,
    }));

  if (insufficient) {
    findings.unshift({
      id: "text-insufficient",
      title: `Insufficient evidence — ${stats.wordCount} words submitted`,
      severity: "INFORMATIONAL",
      confidence: 0,
      signalType: "coverage",
      explanation: `At least ${TEXT_MIN_WORDS} words are required before linguistic signals can be measured with any weight. No score is reported for shorter passages.`,
    });
  }

  const riskLevel: TextReport["riskLevel"] = insufficient
    ? "LOW"
    : aiProbability >= 80
      ? "CRITICAL"
      : aiProbability >= 60
        ? "HIGH"
        : aiProbability >= 35
          ? "MODERATE"
          : "LOW";

  const summary = insufficient
    ? `Insufficient evidence: the specimen contains ${stats.wordCount} words, below the ${TEXT_MIN_WORDS}-word floor required for linguistic assessment.`
    : `${stats.wordCount} words across ${stats.sentenceCount} sentences examined. ${firedCount} of ${availableSignalCount} measurable linguistic signals exceed their uniformity threshold, giving an AI-generation likelihood of ${aiProbability}% (${band(aiProbability)}).`;

  return {
    engineVersion: TEXT_ENGINE_VERSION,
    fileHash,
    mediaKind: "text",
    file: {
      detectedFormat: source.extractedFrom,
      detectedMime: source.declaredMime || "text/plain",
      byteSize: source.byteSize,
      width: null,
      height: null,
      aspectRatio: null,
    },
    exif: {},
    metadataStatus: "MISSING",
    metadataStatusReason: "Text specimens carry no capture-device metadata; this is expected and is scored neutrally.",
    imageStats: { available: false, reason: "Pixel statistics do not apply to text evidence." },
    jpeg: { isJpeg: false },
    c2paPresent: false,
    textStats: stats,
    excerpt: normalized.slice(0, 1200),
    signals,
    signalBreakdown,
    findings,
    aiProbability,
    manipulationProbability: 0,
    authenticityConfidence,
    confidenceStatus: insufficient ? "INSUFFICIENT_EVIDENCE" : "SUFFICIENT",
    confidenceReason: insufficient
      ? `Below the ${TEXT_MIN_WORDS}-word measurement floor.`
      : `${availableSignalCount} of ${contributions.length} linguistic signal families were measurable on this specimen.`,
    riskLevel,
    aiBand: insufficient ? "—" : band(aiProbability),
    manipulationBand: "Not applicable",
    summary,
    availableSignalCount,
  };
}
