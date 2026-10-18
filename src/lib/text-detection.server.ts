/**
 * Sapling AI Detector API text detection (server-only).
 *
 * Endpoint:
 * POST https://api.sapling.ai/api/v1/aidetect
 *
 * Authentication:
 * Authorization: Bearer <AI_DETECTOR_API_KEY>
 *
 * IMPORTANT:
 * - The API key is server-side only.
 * - Never expose the key to the browser.
 * - Scores come directly from Sapling.
 * - No AI score is fabricated if the API fails.
 */

const ENDPOINT =
  "https://api.sapling.ai/api/v1/aidetect";

const TIMEOUT_MS = 45_000;

export interface SentenceScore {
  text: string;

  /** 0-100 AI probability for this sentence. */
  aiProbability: number;
}

export interface TextDetectionResult {
  /** 0-100 AI probability calculated from Sapling's 0-1 score. */
  aiProbability: number;

  /** Exact response field used for the score. */
  sourceField: string;

  classification:
    | "LIKELY_AI"
    | "LIKELY_HUMAN"
    | "UNCERTAIN";

  /** Sapling does not normally return a classification label. */
  apiLabel: string | null;

  language: string | null;

  wordCount: number | null;

  sentences: SentenceScore[];

  /** Additional scalar/string response fields. */
  extra: {
    key: string;
    value: string;
  }[];
}

/**
 * Convert an unknown value to a finite number.
 */
function asNumber(
  value: unknown,
): number | null {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }

  return null;
}

/**
 * Sapling returns the document score from 0 to 1.
 *
 * Example:
 * 0.92 -> 92
 * 0.31 -> 31
 *
 * This function also safely handles an already-percent
 * value in case the API format changes.
 */
function toPercent(value: number): number {
  const percentage =
    value <= 1 ? value * 100 : value;

  return Math.max(
    0,
    Math.min(
      100,
      Math.round(percentage * 10) / 10,
    ),
  );
}

/**
 * Get the main AI score from Sapling's response.
 */
function pickScore(
  payload: Record<string, unknown>,
): {
  value: number;
  field: string;
} | null {
  /*
   * Current Sapling response:
   *
   * {
   *   "score": 0.92,
   *   "sentence_scores": [...]
   * }
   */
  const score = asNumber(payload["score"]);

  if (score !== null) {
    return {
      value: score,
      field: "score",
    };
  }

  /*
   * Fallbacks in case an older/alternate response
   * structure is returned.
   */
  const candidates = [
    "ai_probability",
    "aiProbability",
    "ai_score",
    "aiScore",
    "fake_probability",
    "probability_ai",
    "ai_percentage",
    "confidence",
  ];

  for (const key of candidates) {
    const value = asNumber(payload[key]);

    if (value !== null) {
      return {
        value,
        field: key,
      };
    }
  }

  /*
   * Check common nested response containers.
   */
  for (const container of [
    "result",
    "data",
    "detection",
    "analysis",
  ]) {
    const nested = payload[container];

    if (
      nested &&
      typeof nested === "object"
    ) {
      const found = pickScore(
        nested as Record<string, unknown>,
      );

      if (found) {
        return {
          value: found.value,
          field: `${container}.${found.field}`,
        };
      }
    }
  }

  return null;
}

/**
 * Extract sentence-level scores from Sapling.
 *
 * Current Sapling format:
 *
 * sentence_scores: [
 *   {
 *     score: 0.98,
 *     sentence: "..."
 *   }
 * ]
 */
function pickSentences(
  payload: Record<string, unknown>,
): SentenceScore[] {
  const containers: unknown[] = [
    payload["sentence_scores"],
    payload["sentenceScores"],
    payload["sentences"],
    (
      payload["result"] as
        | Record<string, unknown>
        | undefined
    )?.["sentence_scores"],
    (
      payload["data"] as
        | Record<string, unknown>
        | undefined
    )?.["sentence_scores"],
  ];

  for (const container of containers) {
    if (!Array.isArray(container)) {
      continue;
    }

    const output: SentenceScore[] = [];

    for (const item of container) {
      if (
        !item ||
        typeof item !== "object"
      ) {
        continue;
      }

      const row =
        item as Record<string, unknown>;

      const sentence =
        typeof row["sentence"] === "string"
          ? row["sentence"]
          : typeof row["text"] === "string"
            ? row["text"]
            : null;

      const score =
        asNumber(row["score"]) ??
        asNumber(row["ai_probability"]) ??
        asNumber(row["aiProbability"]) ??
        asNumber(row["ai_score"]) ??
        asNumber(row["aiScore"]);

      if (
        !sentence ||
        score === null
      ) {
        continue;
      }

      output.push({
        text: sentence,
        aiProbability: toPercent(score),
      });
    }

    if (output.length > 0) {
      return output;
    }
  }

  return [];
}

/**
 * Pick useful scalar/string fields for transparent display.
 */
function pickExtra(
  payload: Record<string, unknown>,
): {
  key: string;
  value: string;
}[] {
  const ignored = new Set([
    "score",
    "sentence_scores",
    "sentenceScores",
    "sentences",
    "token_probs",
    "tokens",
    "text",
    "result",
    "data",
    "detection",
    "analysis",
  ]);

  const output: {
    key: string;
    value: string;
  }[] = [];

  for (const [
    key,
    value,
  ] of Object.entries(payload)) {
    if (ignored.has(key)) {
      continue;
    }

    if (
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      output.push({
        key,
        value: String(value),
      });
    } else if (
      typeof value === "string" &&
      value.length <= 120
    ) {
      output.push({
        key,
        value,
      });
    }
  }

  return output.slice(0, 12);
}

/**
 * Convert Sapling's score into the labels
 * used by the SACHSCAN UI.
 *
 * These thresholds are application thresholds,
 * not claims that Sapling itself classifies text
 * this way.
 */
function classify(
  percentage: number,
  apiLabel: string | null,
): TextDetectionResult["classification"] {
  if (apiLabel) {
    const label =
      apiLabel.toLowerCase();

    if (label.includes("human")) {
      return "LIKELY_HUMAN";
    }

    if (
      label.includes("ai") ||
      label.includes("machine") ||
      label.includes("generated")
    ) {
      return "LIKELY_AI";
    }

    if (
      label.includes("mixed") ||
      label.includes("uncertain") ||
      label.includes("unclear")
    ) {
      return "UNCERTAIN";
    }
  }

  if (percentage >= 70) {
    return "LIKELY_AI";
  }

  if (percentage <= 30) {
    return "LIKELY_HUMAN";
  }

  return "UNCERTAIN";
}

/**
 * Detect AI-generated text using Sapling.
 */
export async function detectAiText(
  text: string,
): Promise<TextDetectionResult> {
  const apiKey =
    process.env["AI_DETECTOR_API_KEY"];

  if (!apiKey) {
    throw new Error(
      "Sapling credentials are not configured on the server. Please set AI_DETECTOR_API_KEY in .env.",
    );
  }

  const trimmedText = text.trim();

  if (!trimmedText) {
    throw new Error(
      "Text cannot be empty.",
    );
  }

  /*
   * Sapling recommends providing a reasonably
   * substantial amount of text for a useful signal.
   *
   * We do not reject short text here because your
   * existing SACHSCAN UI already controls the
   * minimum word count.
   */
  const controller =
    new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  let response: Response;

  try {
    response = await fetch(
      ENDPOINT,
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type":
            "application/json",
          Accept: "application/json",
          "User-Agent":
            "SACHSCAN/1.0",
        },

        body: JSON.stringify({
          text: trimmedText,

          /*
           * Ask Sapling to return sentence-level
           * detection scores as well.
           */
          sent_scores: true,
        }),

        signal: controller.signal,
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw new Error(
        "Sapling AI detection timed out. Please retry.",
      );
    }

    console.error(
      "[Sapling] Network error:",
      error,
    );

    throw new Error(
      "Sapling AI detection service could not be reached. Please retry.",
    );
  } finally {
    clearTimeout(timeout);
  }

  /*
   * Read the response body first so that if Sapling
   * returns an error we can show its actual message.
   */
  const raw =
    await response.text();

  if (!response.ok) {
    console.error(
      "[Sapling] API error:",
      {
        status: response.status,
        body: raw,
      },
    );

    if (response.status === 401) {
      throw new Error(
        "Sapling rejected the API key. Check AI_DETECTOR_API_KEY in your .env file.",
      );
    }

    if (response.status === 403) {
      throw new Error(
        "Sapling denied this API request. Check that your API key is active and that your Sapling account has AI Detector API access.",
      );
    }

    if (response.status === 429) {
      throw new Error(
        "Sapling API rate limit reached. Please wait a moment and retry.",
      );
    }

    /*
     * Try to extract Sapling's actual error message.
     */
    let apiMessage = "";

    try {
      const errorPayload =
        JSON.parse(raw) as Record<
          string,
          unknown
        >;

      const possibleMessage =
        errorPayload["msg"] ??
        errorPayload["message"] ??
        errorPayload["error"];

      if (
        typeof possibleMessage === "string"
      ) {
        apiMessage =
          possibleMessage;
      }
    } catch {
      /*
       * Response wasn't JSON.
       */
    }

    throw new Error(
      apiMessage
        ? `Sapling API error (HTTP ${response.status}): ${apiMessage}`
        : `Sapling API error (HTTP ${response.status}).`,
    );
  }

  /*
   * Parse successful JSON response.
   */
  let payload: Record<
    string,
    unknown
  >;

  try {
    payload =
      JSON.parse(raw) as Record<
        string,
        unknown
      >;
  } catch {
    console.error(
      "[Sapling] Invalid JSON response:",
      raw,
    );

    throw new Error(
      "Sapling returned an unreadable response.",
    );
  }

  /*
   * Extract document score.
   */
  const score =
    pickScore(payload);

  if (!score) {
    console.error(
      "[Sapling] No usable score:",
      payload,
    );

    throw new Error(
      "Sapling returned no AI-probability score for this text.",
    );
  }

  const aiProbability =
    toPercent(score.value);

  /*
   * Sapling's current AI detector response
   * does not normally provide a classification
   * label, so this remains null unless one is
   * present in a future/alternate response.
   */
  const apiLabel =
    typeof payload["label"] ===
    "string"
      ? payload["label"]
      : typeof payload["classification"] ===
          "string"
        ? payload[
            "classification"
          ]
        : null;

  const sentences =
    pickSentences(payload);

  /*
   * Sapling's API response doesn't necessarily
   * include word_count, so calculate it from
   * the submitted text when necessary.
   */
  const wordCount =
    asNumber(
      payload["word_count"],
    ) ??
    trimmedText
      .split(/\s+/)
      .filter(Boolean).length;

  const language =
    typeof payload["language"] ===
    "string"
      ? payload["language"]
      : null;

  return {
    aiProbability,

    sourceField:
      score.field,

    classification:
      classify(
        aiProbability,
        apiLabel,
      ),

    apiLabel,

    language,

    wordCount,

    sentences,

    extra:
      pickExtra(payload),
  };
}