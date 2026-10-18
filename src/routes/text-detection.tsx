import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  FileText,
  Loader2,
  Upload,
  X,
} from "lucide-react";

import { useWallet } from "@txnlab/use-wallet-react";

import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import type { ClientAvmSigner } from "@x402/avm";

import {
  Disclaimer,
  PageShell,
  Panel,
  ScoreRing,
} from "@/components/forensic/ui";

import { scoreColorVar } from "@/lib/sachscan";
import { detectText } from "@/lib/text-detection.functions";
import {
  DOC_ACCEPT,
  countWords,
  extractDocumentText,
} from "@/lib/document-text";

import type { TextDetectionResult } from "@/lib/text-detection.server";

export const Route = createFileRoute("/text-detection")({
  head: () => ({
    meta: [
      {
        title: "Text Detection — SACHSCAN AI Text Analysis",
      },
      {
        name: "description",
        content:
          "Analyse pasted text, PDF or Word documents for AI-generated writing with sentence-level detector results.",
      },
      {
        property: "og:title",
        content: "Text Detection — SACHSCAN",
      },
      {
        property: "og:description",
        content:
          "Submit text or a document for probabilistic AI-generation assessment.",
      },
      {
        property: "og:type",
        content: "website",
      },
      {
        name: "twitter:card",
        content: "summary_large_image",
      },
    ],
  }),

  component: TextDetection,
});

const CLASSIFICATION_LABEL: Record<
  TextDetectionResult["classification"],
  string
> = {
  LIKELY_AI: "Likely AI generated",
  LIKELY_HUMAN: "Likely human written",
  UNCERTAIN: "Uncertain",
};

type PremiumVerificationResponse = {
  success: boolean;
  analysis: TextDetectionResult;
  verification: {
    status: string;
    network: string;
    transaction: string;
  };
};

function TextDetection() {
  const runDetect = useServerFn(detectText);
  const fileRef = useRef<HTMLInputElement>(null);

  const {
    wallets,
    activeAccount,
    signTransactions,
  } = useWallet();

  const [text, setText] = useState("");
  const [sourceLabel, setSourceLabel] =
    useState<string | null>(null);

  const [extracting, setExtracting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [paying, setPaying] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [result, setResult] =
    useState<TextDetectionResult | null>(null);

  const [premiumResult, setPremiumResult] =
    useState<PremiumVerificationResponse | null>(null);

  const words = useMemo(() => countWords(text), [text]);
  const chars = text.length;

  const canAnalyze =
    words >= 25 && !analyzing && !extracting;

  const canPay =
    words >= 25 &&
    !paying &&
    !analyzing &&
    !extracting;

  async function onPickFile(file: File | undefined) {
    if (!file) return;

    setError(null);
    setResult(null);
    setPremiumResult(null);
    setExtracting(true);

    try {
      const extracted = await extractDocumentText(file);

      setText(extracted.text);

      setSourceLabel(
        `${file.name}${
          extracted.pages
            ? ` — ${extracted.pages} page${
                extracted.pages === 1 ? "" : "s"
              }`
            : ""
        }`,
      );

      if (countWords(extracted.text) < 25) {
        setError(
          "The extracted text is too short to assess reliably (at least 25 words are required).",
        );
      }
    } catch (e) {
      setText("");
      setSourceLabel(null);

      setError(
        e instanceof Error
          ? e.message
          : "The document could not be read.",
      );
    } finally {
      setExtracting(false);

      if (fileRef.current) {
        fileRef.current.value = "";
      }
    }
  }

  async function analyze() {
    setError(null);
    setResult(null);
    setPremiumResult(null);
    setAnalyzing(true);

    try {
      const res = await runDetect({
        data: { text },
      });

      setResult(res as TextDetectionResult);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Detection failed. Please retry.",
      );
    } finally {
      setAnalyzing(false);
    }
  }

  async function connectWallet() {
    setError(null);

    try {
      const wallet = wallets[0];

      if (!wallet) {
        throw new Error(
          "Pera Wallet is not available.",
        );
      }

      await wallet.connect();
    } catch (e) {
      console.error("Wallet connection failed:", e);

      setError(
        e instanceof Error
          ? e.message
          : "Could not connect the Pera Wallet.",
      );
    }
  }

  async function disconnectWallet() {
    setError(null);

    try {
      const wallet =
        wallets.find((item) => item.isActive) ??
        wallets.find((item) => item.isConnected) ??
        wallets[0];

      if (!wallet) {
        return;
      }

      await wallet.disconnect();
    } catch (e) {
      console.error("Wallet disconnect failed:", e);

      setError(
        e instanceof Error
          ? e.message
          : "Could not disconnect the Pera Wallet.",
      );
    }
  }

  async function unlockFullVerification() {
    if (!activeAccount) {
      setError(
        "Please connect your Pera Wallet first.",
      );
      return;
    }

    if (!text.trim() || words < 25) {
      setError(
        "Please provide at least 25 words before starting verification.",
      );
      return;
    }

    setError(null);
    setPremiumResult(null);
    setPaying(true);

    try {
      /*
       * Create the signer from Pera Wallet.
       */
      const signer: ClientAvmSigner = {
        address: activeAccount.address,

        signTransactions: async (
          txns,
          indexesToSign,
        ) => {
          return await signTransactions(
            txns,
            indexesToSign,
          );
        },
      };

      /*
       * Create x402 client.
       *
       * Your installed @x402/avm@2.25.0 package
       * exports ExactAvmScheme from:
       *
       * @x402/avm/exact/client
       *
       * It does NOT export ExactAvmClient.
       *
       * Registering algorand:* allows the client to
       * match the Algorand CAIP-2 network returned
       * by the x402 V2 payment requirements.
       */
      const client = new x402Client();

      client.register(
        "algorand:*",
        new ExactAvmScheme(signer),
      );

      /*
       * Wrap fetch with x402 payment handling.
       *
       * Flow:
       * 1. Send request.
       * 2. Receive HTTP 402.
       * 3. Read x402 V2 payment requirements.
       * 4. Match the Algorand Exact scheme.
       * 5. Create the payment payload.
       * 6. Ask Pera Wallet to sign.
       * 7. Retry the request with the payment signature.
       */
      const fetchWithPay = wrapFetchWithPayment(
        fetch,
        client,
      );

      const response = await fetchWithPay(
        "/api/premium-text",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: text.trim(),
          }),
        },
      );

      let data: unknown;

      try {
        data = await response.json();
      } catch {
        throw new Error(
          `Verification endpoint returned an invalid response (HTTP ${response.status}).`,
        );
      }

      if (!response.ok) {
        const message =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof (data as { error?: unknown }).error ===
            "string"
            ? (data as { error: string }).error
            : `Payment request failed with HTTP ${response.status}.`;

        throw new Error(message);
      }

      const premiumData =
        data as PremiumVerificationResponse;

      if (!premiumData.success) {
        throw new Error(
          "Full verification did not complete successfully.",
        );
      }

      setPremiumResult(premiumData);
      setResult(premiumData.analysis);
    } catch (e) {
      console.error("x402 payment failed:", e);

      setError(
        e instanceof Error
          ? e.message
          : "Payment or verification failed. Please try again.",
      );
    } finally {
      setPaying(false);
    }
  }

  function clearAll() {
    setText("");
    setSourceLabel(null);
    setResult(null);
    setPremiumResult(null);
    setError(null);
  }

  const highSentences = (
    result?.sentences ?? []
  ).filter((s) => s.aiProbability >= 60);

  return (
    <PageShell
      title="Text Detection"
      subtitle="Submit written text or a document for AI-generation assessment. Scores are returned by the external detector — none are simulated."
      actions={
        <button
          type="button"
          onClick={clearAll}
          disabled={!text && !result}
          className="mono inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[11px] uppercase tracking-[0.12em] transition-colors hover:bg-accent disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" />
          Clear
        </button>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <div className="space-y-5">
          <Panel
            title="Text specimen"
            right={
              <span className="mono text-[11px] text-muted-foreground">
                {words} words · {chars} chars
              </span>
            }
          >
            <label
              htmlFor="specimen"
              className="sr-only"
            >
              Text to analyse
            </label>

            <textarea
              id="specimen"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setSourceLabel(null);
                setPremiumResult(null);
              }}
              placeholder="Paste or type the text to analyse (minimum 25 words)…"
              rows={14}
              className="mono w-full resize-y rounded border border-border bg-surface p-3 text-[13px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
            />

            {sourceLabel ? (
              <p className="mono mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                Extracted from {sourceLabel}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={analyze}
                disabled={!canAnalyze}
                className="mono inline-flex items-center gap-2 rounded bg-primary px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
              >
                {analyzing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}

                {analyzing
                  ? "Analyzing…"
                  : "Analyze text"}
              </button>

              <button
                type="button"
                onClick={() =>
                  fileRef.current?.click()
                }
                disabled={extracting || analyzing}
                className="mono inline-flex items-center gap-2 rounded border border-border px-4 py-2 text-[11px] uppercase tracking-[0.12em] transition-colors hover:bg-accent disabled:opacity-40"
              >
                {extracting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}

                {extracting
                  ? "Extracting…"
                  : "Upload PDF / DOCX"}
              </button>

              <input
                ref={fileRef}
                type="file"
                accept={DOC_ACCEPT}
                className="hidden"
                onChange={(e) =>
                  void onPickFile(
                    e.target.files?.[0],
                  )
                }
              />

              {words > 0 && words < 25 ? (
                <span className="text-[11px] text-muted-foreground">
                  At least 25 words required.
                </span>
              ) : null}
            </div>

            {analyzing ? (
              <p
                className="mono mt-3 text-[11px] text-muted-foreground"
                role="status"
              >
                Text submitted to the detector —
                analysing…
              </p>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2 rounded border border-destructive/50 bg-destructive/10 p-3 text-[12px]"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />

                <div>
                  <p>{error}</p>

                  {!paying ? (
                    <button
                      type="button"
                      onClick={analyze}
                      disabled={!canAnalyze}
                      className="mono mt-2 rounded border border-border px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] transition-colors hover:bg-accent disabled:opacity-40"
                    >
                      Retry analysis
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </Panel>

          {result &&
          result.sentences.length > 0 ? (
            <Panel title="Sentence-level detector scores">
              <ul className="space-y-2">
                {result.sentences.map((s, i) => (
                  <li
                    key={`${i}-${s.text.slice(
                      0,
                      12,
                    )}`}
                    className="flex items-start gap-3 rounded border border-border bg-surface p-2.5"
                  >
                    <span
                      className="mono shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold"
                      style={{
                        color: "var(--background)",
                        background: scoreColorVar(
                          s.aiProbability,
                        ),
                      }}
                    >
                      {s.aiProbability}%
                    </span>

                    <p className="text-[12px] leading-relaxed text-foreground">
                      {s.text}
                    </p>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>

        <div className="space-y-5">
          <Panel title="Detector result">
            {result ? (
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <ScoreRing
                    value={result.aiProbability}
                    label="AI probability"
                  />

                  <div>
                    <p className="mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      Classification
                    </p>

                    <p className="mt-1 text-sm font-semibold">
                      {
                        CLASSIFICATION_LABEL[
                          result.classification
                        ]
                      }
                    </p>

                    {result.apiLabel ? (
                      <p className="mono mt-1 text-[11px] text-muted-foreground">
                        API label: {result.apiLabel}
                      </p>
                    ) : null}
                  </div>
                </div>

                <dl className="mono grid grid-cols-2 gap-2 text-[11px]">
                  {result.language ? (
                    <div>
                      <dt className="text-muted-foreground">
                        Language
                      </dt>
                      <dd>{result.language}</dd>
                    </div>
                  ) : null}

                  {result.wordCount !== null ? (
                    <div>
                      <dt className="text-muted-foreground">
                        Words analysed
                      </dt>
                      <dd>{result.wordCount}</dd>
                    </div>
                  ) : null}

                  <div>
                    <dt className="text-muted-foreground">
                      Score field
                    </dt>
                    <dd>{result.sourceField}</dd>
                  </div>

                  {result.extra.map((e) => (
                    <div key={e.key}>
                      <dt className="text-muted-foreground">
                        {e.key}
                      </dt>
                      <dd className="break-words">
                        {e.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground">
                No analysis yet. Paste text or upload a
                PDF/DOCX document, then run the detector.
              </p>
            )}
          </Panel>

          <Panel title="Full Verification">
            <div className="space-y-4">
              <div>
                <p className="text-sm font-semibold">
                  Unlock Full Verification
                </p>

                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  Run the verification through SACHSCAN&apos;s
                  paid x402 endpoint using 0.01 USDC on
                  Algorand Testnet.
                </p>
              </div>

              {!activeAccount ? (
                <button
                  type="button"
                  onClick={() =>
                    void connectWallet()
                  }
                  disabled={paying}
                  className="mono inline-flex w-full items-center justify-center gap-2 rounded bg-primary px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                >
                  Connect Pera Wallet
                </button>
              ) : (
                <>
                  <div className="rounded border border-border bg-surface p-3">
                    <p className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      Connected wallet
                    </p>

                    <p className="mono mt-1 break-all text-[11px] text-foreground">
                      {activeAccount.address}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      void unlockFullVerification()
                    }
                    disabled={!canPay}
                    className="mono inline-flex w-full items-center justify-center gap-2 rounded bg-primary px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                  >
                    {paying ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}

                    {paying
                      ? "Processing payment…"
                      : "Unlock Full Verification — 0.01 USDC"}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      void disconnectWallet()
                    }
                    disabled={paying}
                    className="mono w-full rounded border border-border px-4 py-2 text-[10px] uppercase tracking-[0.12em] transition-colors hover:bg-accent disabled:opacity-40"
                  >
                    Disconnect Wallet
                  </button>
                </>
              )}

              {premiumResult ? (
                <div className="rounded border border-border bg-surface p-3">
                  <p className="mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    Verification paid
                  </p>

                  <p className="mt-1 text-sm font-semibold">
                    Full verification completed
                  </p>

                  <p className="mono mt-3 text-[10px] text-muted-foreground">
                    Algorand Testnet transaction
                  </p>

                  <p className="mono mt-1 break-all text-[11px] text-foreground">
                    {
                      premiumResult.verification
                        .transaction
                    }
                  </p>
                </div>
              ) : null}
            </div>
          </Panel>

          {result ? (
            <Panel title="Why was this detected as AI?">
              <div className="space-y-2 text-[12px] leading-relaxed text-muted-foreground">
                <p>
                  This text was classified as{" "}
                  <span className="text-foreground">
                    {
                      CLASSIFICATION_LABEL[
                        result.classification
                      ].toLowerCase()
                    }
                  </span>{" "}
                  based on the detector&apos;s analysis,
                  which returned an AI probability of{" "}
                  <span className="mono text-foreground">
                    {result.aiProbability}%
                  </span>
                  {result.apiLabel
                    ? ` and the label "${result.apiLabel}"`
                    : ""}
                  .
                </p>

                {result.sentences.length > 0 ? (
                  highSentences.length > 0 ? (
                    <>
                      <p>
                        {highSentences.length} of{" "}
                        {result.sentences.length} sentences
                        received a high AI score from the
                        detector and contributed most to this
                        classification:
                      </p>

                      <ul className="space-y-1.5">
                        {highSentences
                          .slice(0, 5)
                          .map((s, i) => (
                            <li
                              key={i}
                              className="rounded border border-border bg-surface p-2 text-foreground"
                            >
                              <span className="mono mr-2 text-[10px] text-muted-foreground">
                                {s.aiProbability}%
                              </span>

                              {s.text}
                            </li>
                          ))}
                      </ul>
                    </>
                  ) : (
                    <p>
                      No individual sentence was scored
                      highly by the detector; the overall
                      score reflects the passage as a whole.
                    </p>
                  )
                ) : (
                  <p>
                    The detector returned an overall score
                    only — no sentence-level or
                    feature-level breakdown was provided
                    for this text, so no further reasons
                    can be given.
                  </p>
                )}

                <p className="text-[11px]">
                  AI detection is probabilistic and may
                  produce false positives or false
                  negatives.
                </p>
              </div>
            </Panel>
          ) : null}

          <Disclaimer />
        </div>
      </div>
    </PageShell>
  );
}