import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import {
  UploadCloud,
  FileWarning,
  CheckCircle2,
  RefreshCw,
  FileText,
  Wallet,
  Lock,
  CreditCard,
  Link as LinkIcon,
} from "lucide-react";
import { toast } from "sonner";

import { useWallet } from "@txnlab/use-wallet-react";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import type { ClientAvmSigner } from "@x402/avm";

import { supabase } from "@/integrations/supabase/client";

import {
  ACCEPTED_EXT,
  ACCEPTED_TYPES,
  EVIDENCE_KIND_LABEL,
  MAX_FILE_BYTES,
  evidenceKind,
  formatBytes,
  type EvidenceKind,
} from "@/lib/sachscan";

import {
  countWords,
  extractDocumentText,
} from "@/lib/document-text";

import {
  Disclaimer,
  KeyValue,
  PageShell,
  Panel,
} from "@/components/forensic/ui";

const ALGORAND_TESTNET_NETWORK =
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" as `${string}:${string}`;

export const Route = createFileRoute(
  "/investigations/$id/upload",
)({
  head: () => ({
    meta: [
      {
        title: "Evidence Intake — SACHSCAN",
      },
      {
        name: "description",
        content:
          "Ingest image, video or text evidence into a SACHSCAN investigation with per-type validation, fingerprinting and optional paid full verification.",
      },
      {
        property: "og:title",
        content: "Evidence Intake — SACHSCAN",
      },
      {
        property: "og:description",
        content:
          "Validated evidence upload for digital media forensic examination.",
      },
    ],
  }),

  component: UploadEvidence,
});

interface Prepared {
  file: File;
  kind: EvidenceKind;
  width: number;
  height: number;
  hash: string;
  previewUrl: string;

  text?: string;
  wordCount?: number;
  extractedFrom?: string;

  durationSeconds?: number;
}

type VerificationMode =
  | "free"
  | "full";

interface PremiumResponse {
  success?: boolean;

  analysis?: unknown;

  verification?: {
    status?: string;
    network?: string;
    transaction?: string;
  };

  error?: string;
}


async function sha256(
  file: Blob,
): Promise<string> {
  const buf =
    await file.arrayBuffer();

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      buf,
    );

  return Array.from(
    new Uint8Array(digest),
  )
    .map((b) =>
      b
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
}

function decode(
  file: File,
): Promise<{
  width: number;
  height: number;
  url: string;
}> {
  return new Promise(
    (resolve, reject) => {
      const url =
        URL.createObjectURL(
          file,
        );

      const img =
        new Image();

      img.onload = () => {
        resolve({
          width:
            img.naturalWidth,
          height:
            img.naturalHeight,
          url,
        });
      };

      img.onerror = () => {
        URL.revokeObjectURL(
          url,
        );

        reject(
          new Error(
            "The file could not be decoded as an image and may be corrupted or truncated.",
          ),
        );
      };

      img.src = url;
    },
  );
}

function probeVideo(
  file: File,
): Promise<{
  width: number;
  height: number;
  duration: number;
  url: string;
}> {
  return new Promise(
    (resolve, reject) => {
      const url =
        URL.createObjectURL(
          file,
        );

      const video =
        document.createElement(
          "video",
        );

      video.preload =
        "metadata";

      video.muted = true;

      const fail = () => {
        URL.revokeObjectURL(
          url,
        );

        reject(
          new Error(
            "This video could not be decoded by the browser. The file may be corrupted, or its codec is not supported here.",
          ),
        );
      };

      video.onloadedmetadata =
        () => {
          if (
            !video.videoWidth ||
            !Number.isFinite(
              video.duration,
            ) ||
            video.duration <= 0
          ) {
            fail();
            return;
          }

          resolve({
            width:
              video.videoWidth,
            height:
              video.videoHeight,
            duration:
              video.duration,
            url,
          });
        };

      video.onerror = fail;

      setTimeout(() => {
        reject(
          new Error(
            "The video did not report its metadata within 20 seconds.",
          ),
        );
      }, 20_000);

      video.src = url;
    },
  );
}

function uploadWithProgress(
  path: string,
  body: Blob,
  contentType: string,
  onProgress: (
    pct: number,
  ) => void,
): Promise<void> {
  return new Promise(
    (resolve, reject) => {
      const base =
        import.meta.env[
          "VITE_SUPABASE_URL"
        ] as string;

      const key =
        import.meta.env[
          "VITE_SUPABASE_PUBLISHABLE_KEY"
        ] as string;

      const xhr =
        new XMLHttpRequest();

      xhr.open(
        "POST",
        `${base}/storage/v1/object/evidence/${path}`,
      );

      xhr.setRequestHeader(
        "apikey",
        key,
      );

      xhr.setRequestHeader(
        "authorization",
        `Bearer ${key}`,
      );

      xhr.setRequestHeader(
        "x-upsert",
        "true",
      );

      xhr.setRequestHeader(
        "content-type",
        contentType ||
          "application/octet-stream",
      );

      xhr.upload.onprogress =
        (e) => {
          if (
            e.lengthComputable
          ) {
            onProgress(
              Math.round(
                (e.loaded /
                  e.total) *
                  100,
              ),
            );
          }
        };

      xhr.onload = () => {
        if (
          xhr.status >= 200 &&
          xhr.status < 300
        ) {
          resolve();
        } else {
          reject(
            new Error(
              `Storage rejected the upload (HTTP ${xhr.status}): ${xhr.responseText.slice(
                0,
                200,
              )}`,
            ),
          );
        }
      };

      xhr.onerror = () => {
        reject(
          new Error(
            "Network failure while transferring the evidence file.",
          ),
        );
      };

      xhr.send(body);
    },
  );
}

/**
 * x402 Full Verification payment
 */
async function payForFullVerification(
  investigationId: string,
  storagePath: string,
  activeAccount: {
    address: string;
  },
  signTransactions: any,
): Promise<PremiumResponse> {
  const signer: ClientAvmSigner = {
    address:
      activeAccount.address,

    signTransactions:
      async (
        txns,
        indexesToSign,
      ) => {
        return await signTransactions(
          txns,
          indexesToSign,
        );
      },
  };

  /**
   * Create x402 client.
   */
  const client =
    new x402Client();

  /**
   * Register Algorand
   * Testnet exact scheme.
   */
  client.register(
    ALGORAND_TESTNET_NETWORK,
    new ExactAvmScheme(
      signer,
    ),
  );

  /**
   * Wrap normal fetch
   * with x402 payment support.
   */
  const fetchWithPay =
    wrapFetchWithPayment(
      fetch,
      client,
    );

  const response =
    await fetchWithPay(
      "/api/premium-media",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          investigationId,
          storagePath,
        }),
      },
    );

  let data: PremiumResponse =
    {};

  try {
    data =
      (await response.json()) as PremiumResponse;
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(
      typeof data.error ===
        "string"
        ? data.error
        : `Payment or verification failed with HTTP ${response.status}.`,
    );
  }

  return data;
}

function UploadEvidence() {
  const { id } =
    Route.useParams();

  const navigate =
    useNavigate();

  const inputRef =
    useRef<HTMLInputElement>(
      null,
    );

  const {
    wallets,
    activeAccount,
    signTransactions,
  } = useWallet();

  const [
    prepared,
    setPrepared,
  ] =
    useState<Prepared | null>(
      null,
    );

  const [
    validationError,
    setValidationError,
  ] =
    useState<string | null>(
      null,
    );

  const [
    limitedNotice,
    setLimitedNotice,
  ] =
    useState<string | null>(
      null,
    );

  const [
    progress,
    setProgress,
  ] =
    useState<number | null>(
      null,
    );

  const [
    uploadError,
    setUploadError,
  ] =
    useState<string | null>(
      null,
    );

  const [
    dragging,
    setDragging,
  ] =
    useState(false);

  const [
    preparing,
    setPreparing,
  ] =
    useState(false);

  const [
    verificationMode,
    setVerificationMode,
  ] =
    useState<VerificationMode>(
      "free",
    );

  const [
    paying,
    setPaying,
  ] =
    useState(false);

  const [
    paymentError,
    setPaymentError,
  ] =
    useState<string | null>(
      null,
    );

  const [
    paymentTransaction,
    setPaymentTransaction,
  ] =
    useState<string | null>(
      null,
    );

  const [
    paymentCompleted,
    setPaymentCompleted,
  ] =
    useState(false);

  const [mediaUrl, setMediaUrl] = useState("");
  const [inputMode, setInputMode] = useState<"upload" | "url">("upload");
  const [urlImporting, setUrlImporting] = useState(false);
  const [urlImportError, setUrlImportError] = useState<string | null>(null);

  /**
   * Prepare file
   */
  const handleFile =
    useCallback(
      async (file: File): Promise<boolean> => {
        setValidationError(
          null,
        );

        setUploadError(
          null,
        );

        setLimitedNotice(
          null,
        );

        setPaymentError(
          null,
        );

        setPaymentTransaction(
          null,
        );

        setPaymentCompleted(
          false,
        );

        setPrepared(null);

        const ext =
          file.name.includes(
            ".",
          )
            ? file.name
                .slice(
                  file.name.lastIndexOf(
                    ".",
                  ),
                )
                .toLowerCase()
            : "";

        const kind =
          evidenceKind(
            file.name,
            file.type,
          );

        if (
          file.type.startsWith(
            "audio/",
          )
        ) {
          setValidationError(
            "Audio evidence cannot be ingested in this build.",
          );

          return false;
        }

        if (
          kind ===
            "unsupported" ||
          (!ACCEPTED_TYPES.includes(
            file.type,
          ) &&
            !ACCEPTED_EXT.includes(
              ext,
            ))
        ) {
          setValidationError(
            `Unsupported evidence format. Accepted formats: ${ACCEPTED_EXT.join(
              " ",
            )}.`,
          );

          return false;
        }

        if (
          file.size >
          MAX_FILE_BYTES
        ) {
          setValidationError(
            `File exceeds the ${formatBytes(
              MAX_FILE_BYTES,
            )} intake limit.`,
          );

          return false;
        }

        if (file.size === 0) {
          setValidationError(
            "This file is empty.",
          );

          return false;
        }

        setPreparing(true);

        try {
          const hash =
            await sha256(file);

          /**
           * IMAGE
           */
          if (
            kind === "image"
          ) {
            const {
              width,
              height,
              url,
            } =
              await decode(file);

            setPrepared({
              file,
              kind,
              width,
              height,
              hash,
              previewUrl: url,
            });

            return true;
          }

          /**
           * VIDEO
           */
          if (
            kind === "video"
          ) {
            const probe =
              await probeVideo(
                file,
              );

            if (
              probe.duration >
              60
            ) {
              setLimitedNotice(
                `Only the first 60 seconds of this ${Math.round(
                  probe.duration,
                )}-second video will be analysed.`,
              );
            }

            setPrepared({
              file,
              kind,
              width:
                probe.width,
              height:
                probe.height,
              hash,
              previewUrl:
                probe.url,
              durationSeconds:
                probe.duration,
            });

            return true;
          }

          /**
           * TEXT
           */
          let text: string;
          let extractedFrom: string;

          if (
            ext === ".pdf" ||
            ext === ".docx"
          ) {
            const result =
              await extractDocumentText(
                file,
              );

            text =
              result.text;

            extractedFrom =
              ext === ".pdf"
                ? "PDF EXTRACTION"
                : "DOCX EXTRACTION";
          } else {
            text =
              (
                await file.text()
              )
                .replace(
                  /\r\n/g,
                  "\n",
                )
                .trim();

            extractedFrom =
              "PLAIN TEXT";
          }

          if (!text) {
            throw new Error(
              "No readable text could be extracted from this file.",
            );
          }

          const wordCount =
            countWords(text);

          if (
            wordCount < 50
          ) {
            setLimitedNotice(
              `This specimen contains ${wordCount} words. Below 50 words the linguistic engine reports "insufficient evidence" rather than a score.`,
            );
          }

          setPrepared({
            file,
            kind,
            width: 0,
            height: 0,
            hash,
            previewUrl: "",
            text,
            wordCount,
            extractedFrom,
          });
          return true;
        } catch (e) {
          setValidationError(
            e instanceof Error
              ? e.message
              : "The file could not be prepared.",
          );
          return false;
        } finally {
          setPreparing(
            false,
          );
        }
      },
      [],
    );

  /**
   * Connect Pera Wallet
   */
  async function connectWallet() {
    setPaymentError(
      null,
    );

    try {
      const wallet =
        wallets.find(
          (item) =>
            item.id ===
            "pera",
        ) ??
        wallets[0];

      if (!wallet) {
        throw new Error(
          "Pera Wallet is not available.",
        );
      }

      await wallet.connect();

      toast.success(
        "Pera Wallet connected.",
      );
    } catch (e) {
      setPaymentError(
        e instanceof Error
          ? e.message
          : "Could not connect the Pera Wallet.",
      );
    }
  }

  /**
   * Disconnect wallet
   */
  async function disconnectWallet() {
    try {
      const wallet =
        wallets.find(
          (item) =>
            item.isActive,
        ) ??
        wallets.find(
          (item) =>
            item.isConnected,
        ) ??
        wallets[0];

      if (wallet) {
        await wallet.disconnect();
      }

      setPaymentCompleted(
        false,
      );

      setPaymentTransaction(
        null,
      );

      toast.success(
        "Wallet disconnected.",
      );
    } catch (e) {
      setPaymentError(
        e instanceof Error
          ? e.message
          : "Could not disconnect the wallet.",
      );
    }
  }

  /**
   * Fetch a public direct-media URL and prepare it as normal evidence.
   * It then uses the same upload, analysis and verification flow as a local file.
   */
  async function importMediaUrl() {
    setUrlImportError(null);
    setValidationError(null);
    const candidate = mediaUrl.trim();

    if (!candidate) {
      setUrlImportError("Paste a public image or video URL first.");
      return;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("Only HTTP and HTTPS media URLs are supported.");
      }
    } catch (error) {
      setUrlImportError(error instanceof Error ? error.message : "Enter a valid media URL.");
      return;
    }

    setUrlImporting(true);
    try {
      const response = await fetch("/api/url-detection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: candidate }),
      });

      if (!response.ok) {
        let message = `Could not import media (HTTP ${response.status}).`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) message = payload.error;
        } catch {
          // Keep the generic error when the endpoint response is not JSON.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const suppliedName = response.headers.get("X-SACHSCAN-Filename");
      const fallbackExtension = blob.type.startsWith("video/") ? ".mp4" : ".jpg";
      const filename = suppliedName || `url-evidence${fallbackExtension}`;
      const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
      const valid = await handleFile(file);
      if (!valid) throw new Error("The downloaded media failed SACHSCAN's evidence validation.");
      setUrlImportError(null);
      toast.success("Media loaded. Choose verification and click Ingest & Analyse.");
    } catch (error) {
      setUrlImportError(
        error instanceof Error
          ? error.message
          : "Could not import this media URL. Try a direct public image or video link.",
      );
    } finally {
      setUrlImporting(false);
    }
  }

  /**
   * Upload evidence
   */
  async function uploadEvidence(): Promise<string> {
    if (!prepared) {
      throw new Error(
        "Please select evidence first.",
      );
    }

    setUploadError(
      null,
    );

    setProgress(0);

    const name =
      prepared.file.name;

    const ext =
      name.includes(".")
        ? name
            .slice(
              name.lastIndexOf(
                ".",
              ),
            )
            .toLowerCase()
        : "";

    const path =
      `${id}/${prepared.hash}${ext}`;

    try {
      try {
        await uploadWithProgress(
          path,
          prepared.file,
          prepared.file.type,
          setProgress,
        );
      } catch (e) {
        const existing =
          await supabase.storage
            .from("evidence")
            .createSignedUrl(
              path,
              60,
            );

        if (
          !existing.data
            ?.signedUrl
        ) {
          throw e;
        }
      }

      /**
       * Store extracted text
       */
      if (
        prepared.kind ===
          "text" &&
        prepared.text
      ) {
        await uploadWithProgress(
          `${path}.extracted.txt`,
          new Blob(
            [prepared.text],
            {
              type:
                "text/plain",
            },
          ),
          "text/plain",
          () => {},
        );
      }

      setProgress(100);

      /**
       * Database evidence row
       * Temporary diagnostic: verify the Supabase auth context before INSERT.
       * Do not log access tokens or session objects.
       */
      const {
        data: { user: uploadUser },
        error: uploadAuthError,
      } = await supabase.auth.getUser();

      const {
        data: { session: uploadSession },
        error: sessionError,
      } = await supabase.auth.getSession();

      console.log("SACHSCAN evidence INSERT diagnostic:", {
        investigationId: id,
        isAuthenticated: Boolean(uploadUser),
        userId: uploadUser?.id ?? null,
        sessionExists: Boolean(uploadSession),
        sessionError: sessionError?.message ?? null,
        authError: uploadAuthError?.message ?? null,
      });

      const { error } =
        await supabase
          .from("evidence")
          .insert({
            investigation_id:
              id,

            file_name:
              name,

            file_type:
              prepared.file
                .type ||
              (prepared.kind ===
              "text"
                ? "text/plain"
                : ""),

            file_size:
              prepared.file
                .size,

            file_url:
              path,

            file_hash:
              prepared.hash,

            width:
              prepared.width,

            height:
              prepared.height,
          });

      if (error) {
        throw new Error(
          `Evidence record could not be written: ${error.message}`,
        );
      }

      /**
       * Update investigation
       */
      const {
        error:
          investigationError,
      } =
        await supabase
          .from(
            "investigations",
          )
          .update({
            evidence_name:
              name,

            evidence_type:
              prepared.file
                .type ||
              (prepared.kind ===
              "text"
                ? "text/plain"
                : ""),

            status:
              "analysing",
          })
          .eq(
            "id",
            id,
          );

      if (
        investigationError
      ) {
        throw new Error(
          `Investigation could not be updated: ${investigationError.message}`,
        );
      }

      return path;
    } catch (e) {
      setProgress(
        null,
      );

      throw e;
    }
  }

  /**
   * Main action
   */
  async function ingest() {
    if (!prepared) {
      return;
    }

    setUploadError(
      null,
    );

    setPaymentError(
      null,
    );

    setPaymentTransaction(
      null,
    );

    setPaymentCompleted(
      false,
    );

    try {
      /**
       * Upload first.
       */
      const storagePath =
        await uploadEvidence();

      toast.success(
        "Evidence uploaded successfully.",
      );

      /**
       * FREE MODE
       */
      if (
        verificationMode ===
        "free"
      ) {
        toast.success(
          "Starting standard forensic analysis.",
        );

        navigate({
          to:
            "/investigations/$id/analysis",
          params: {
            id,
          },
        });

        return;
      }

      /**
       * FULL MODE
       */
      if (!activeAccount) {
        throw new Error(
          "Please connect your Pera Wallet before purchasing Full Verification.",
        );
      }

      setPaying(true);

      const result =
        await payForFullVerification(
          id,
          storagePath,
          activeAccount,
          signTransactions,
        );

      setPaymentCompleted(
        true,
      );

      const tx =
        result
          ?.verification
          ?.transaction;

      if (tx) {
        setPaymentTransaction(
          tx,
        );
      }

      toast.success(
        "Payment verified. Full Verification completed.",
      );

      setTimeout(() => {
        navigate({
          to: "/investigations/$id",
          params: { id },
          search: mediaUrl.trim() ? ({ sourceUrl: mediaUrl.trim() } as never) : ({} as never),
        });
      }, 700);
    } catch (e) {
      console.error(
        "[SACHSCAN] upload/payment failed:",
        e,
      );

      const message =
        e instanceof Error
          ? e.message
          : "Upload, payment or verification failed.";

      if (
        verificationMode ===
        "full"
      ) {
        setPaymentError(
          message,
        );
      } else {
        setUploadError(
          message,
        );
      }

      setProgress(
        null,
      );
    } finally {
      setPaying(false);
    }
  }

  return (
    <PageShell
      title="Evidence intake"
      subtitle="Case intake — step 2 of 3"
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">

        {/* LEFT */}
        <Panel title="Evidence intake">
          <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-2/40 p-1">
            <button
              type="button"
              aria-pressed={inputMode === "upload"}
              onClick={() => setInputMode("upload")}
              disabled={preparing || paying || urlImporting}
              className={`rounded-md px-3 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${inputMode === "upload" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <UploadCloud className="mr-2 inline size-4" /> Upload image
            </button>
            <button
              type="button"
              aria-pressed={inputMode === "url"}
              onClick={() => setInputMode("url")}
              disabled={preparing || paying || urlImporting}
              className={`rounded-md px-3 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${inputMode === "url" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <LinkIcon className="mr-2 inline size-4" /> Paste URL
            </button>
          </div>

          {inputMode === "upload" ? (
          <>
          {/* Upload area */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() =>
              setDragging(false)
            }
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);

              const file =
                e.dataTransfer
                  .files?.[0];

              if (file) {
                void handleFile(
                  file,
                );
              }
            }}
            onClick={() =>
              inputRef.current?.click()
            }
            className={`flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-6 py-12 text-center transition-colors ${
              dragging
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/60"
            }`}
          >
            <UploadCloud className="size-7 text-primary" />

            <p className="mt-3 text-sm font-medium">
              Drop image, video or
              text evidence here,
              or click to browse
            </p>

            <p className="mono mt-1.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {ACCEPTED_EXT.join(
                " · ",
              )}{" "}
              — max{" "}
              {formatBytes(
                MAX_FILE_BYTES,
              )}
            </p>

            <input
              ref={inputRef}
              type="file"
              accept={[
                ...ACCEPTED_EXT,
                ...ACCEPTED_TYPES,
              ].join(",")}
              className="hidden"
              onChange={(e) => {
                const file =
                  e.target.files?.[0];

                if (file) {
                  void handleFile(
                    file,
                  );
                }
              }}
            />
          </div>

          </>
          ) : (
            <div className="rounded-md border border-border p-4">
              <div className="mb-3">
                <h3 className="text-sm font-semibold">Paste the public image or post URL</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Use the same URL for evidence intake and automatic Source Trace. Public direct image links work best; social pages may block media retrieval or require login.
                </p>
              </div>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void importMediaUrl();
                }}
              >
                <label htmlFor="sachscan-media-url" className="block text-xs font-medium text-foreground">
                  Evidence URL
                </label>
                <input
                  id="sachscan-media-url"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  value={mediaUrl}
                  onChange={(event) => {
                    setMediaUrl(event.target.value);
                    setUrlImportError(null);
                  }}
                  placeholder="https://example.com/image.jpg or a public post URL"
                  maxLength={4096}
                  disabled={urlImporting || preparing || paying}
                  className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm outline-none transition-colors focus:border-primary disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={urlImporting || preparing || paying || !mediaUrl.trim()}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {urlImporting ? (
                    <><RefreshCw className="size-4 animate-spin" /> Loading URL…</>
                  ) : (
                    <><LinkIcon className="size-4" /> Use this URL</>
                  )}
                </button>
              </form>
              {urlImportError ? (
                <div role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {urlImportError}
                </div>
              ) : null}
            </div>
          )}

          {/* Preparing */}
          {preparing ? (
            <p className="mono mt-3 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Validating and
              fingerprinting the
              file…
            </p>
          ) : null}

          {/* Notice */}
          {limitedNotice ? (
            <p
              className="mt-3 rounded-md border px-3 py-2 text-xs"
              style={{
                borderColor:
                  "var(--warn)",
                color:
                  "var(--warn)",
              }}
            >
              {limitedNotice}
            </p>
          ) : null}

          {/* Validation error */}
          {validationError ? (
            <p className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <FileWarning className="mt-0.5 size-4 shrink-0" />

              {validationError}
            </p>
          ) : null}

          {/* Prepared file */}
          {prepared ? (
            <div className="mt-5 grid gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">

              {prepared.kind ===
              "video" ? (
                <video
                  src={
                    prepared.previewUrl
                  }
                  muted
                  className="h-[120px] w-full rounded border border-border object-cover"
                />
              ) : prepared.kind ===
                "text" ? (
                <div className="flex h-[120px] w-full items-center justify-center rounded border border-border bg-surface-2">
                  <FileText className="size-8 text-primary" />
                </div>
              ) : (
                <img
                  src={
                    prepared.previewUrl
                  }
                  alt={`Preview of evidence file ${prepared.file.name}`}
                  className="h-[120px] w-full rounded border border-border object-cover"
                />
              )}

              <KeyValue
                items={[
                  {
                    k: "Evidence type",
                    v:
                      EVIDENCE_KIND_LABEL[
                        prepared.kind
                      ] ??
                      "—",
                    mono: true,
                  },

                  {
                    k: "File name",
                    v:
                      prepared.file
                        .name,
                    mono: true,
                  },

                  {
                    k: "MIME type",
                    v:
                      prepared.file
                        .type ||
                      "—",
                    mono: true,
                  },

                  {
                    k: "Size",
                    v: formatBytes(
                      prepared.file
                        .size,
                    ),
                    mono: true,
                  },

                  {
                    k:
                      prepared.kind ===
                      "text"
                        ? "Extraction"
                        : "Dimensions",

                    v:
                      prepared.kind ===
                      "text"
                        ? `${prepared.extractedFrom} — ${prepared.wordCount} words`
                        : prepared.kind ===
                          "video"
                          ? `${prepared.width} × ${prepared.height}, ${Math.round(
                              prepared.durationSeconds ??
                                0,
                            )}s`
                          : `${prepared.width} × ${prepared.height}`,

                    mono: true,
                  },

                  {
                    k: "SHA-256",
                    v:
                      prepared.hash,
                    mono: true,
                  },
                ]}
              />
            </div>
          ) : null}

          {/* Text preview */}
          {prepared?.kind ===
            "text" &&
          prepared.text ? (
            <div className="mono mt-4 max-h-40 overflow-auto rounded border border-border bg-surface-2 p-3 text-[11px] leading-relaxed text-muted-foreground">
              {prepared.text.slice(
                0,
                800,
              )}

              {prepared.text.length >
              800
                ? "…"
                : ""}
            </div>
          ) : null}

          {/* Progress */}
          {progress !==
          null ? (
            <div className="mt-5">
              <div className="mono mb-1.5 flex justify-between text-[11px] text-muted-foreground">
                <span>
                  Transferring to
                  evidence store
                </span>

                <span>
                  {progress}%
                </span>
              </div>

              <div className="h-1.5 w-full overflow-hidden rounded bg-surface-2">
                <div
                  className="h-full bg-primary transition-[width] duration-200"
                  style={{
                    width: `${progress}%`,
                  }}
                />
              </div>

              {progress ===
              100 ? (
                <p
                  className="mt-2 flex items-center gap-1.5 text-xs"
                  style={{
                    color:
                      "var(--ok)",
                  }}
                >
                  <CheckCircle2 className="size-3.5" />

                  Transfer confirmed
                  by the evidence
                  store.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Upload error */}
          {uploadError ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span>
                {uploadError}
              </span>

              <button
                type="button"
                onClick={
                  ingest
                }
                className="inline-flex items-center gap-1.5 rounded border border-destructive/50 px-2.5 py-1 text-xs"
              >
                <RefreshCw className="size-3.5" />

                Retry
              </button>
            </div>
          ) : null}

          {/* Verification selection */}
          {prepared ? (
            <div className="mt-6 rounded-lg border border-border bg-surface-2/40 p-4">

              <div className="mb-3">
                <h3 className="text-sm font-semibold">
                  Choose verification
                </h3>

                <p className="mt-1 text-xs text-muted-foreground">
                  Select standard analysis
                  or unlock Full
                  Verification with an
                  x402 micropayment.
                </p>
              </div>

              <div className="grid gap-3">

                {/* FREE */}
                <button
                  type="button"
                  disabled={paying}
                  onClick={() =>
                    setVerificationMode(
                      "free",
                    )
                  }
                  className={`rounded-lg border p-4 text-left transition-colors ${
                    verificationMode ===
                    "free"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <div className="flex items-start gap-3">

                    <div className="rounded-md border border-border p-2">
                      <CheckCircle2 className="size-4 text-primary" />
                    </div>

                    <div className="min-w-0 flex-1">

                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold">
                          Standard
                          Verification
                        </span>

                        <span className="mono text-[11px] text-muted-foreground">
                          FREE
                        </span>
                      </div>

                      <p className="mt-1 text-xs text-muted-foreground">
                        Get the basic AI-generation likelihood assessment only. Forensics and source tracing require Full Verification.
                      </p>

                    </div>
                  </div>
                </button>

                {/* FULL */}
                <button
                  type="button"
                  disabled={paying}
                  onClick={() =>
                    setVerificationMode(
                      "full",
                    )
                  }
                  className={`rounded-lg border p-4 text-left transition-colors ${
                    verificationMode ===
                    "full"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <div className="flex items-start gap-3">

                    <div className="rounded-md border border-border p-2">
                      <Lock className="size-4 text-primary" />
                    </div>

                    <div className="min-w-0 flex-1">

                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold">
                          Full
                          Verification
                        </span>

                        <span className="mono text-[11px] font-semibold text-primary">
                          0.01 USDC
                        </span>
                      </div>

                      <p className="mt-1 text-xs text-muted-foreground">
                        Unlock the paid
                        verification endpoint
                        through x402 on
                        Algorand Testnet.
                      </p>

                      <div className="mt-2 flex flex-wrap gap-2">

                        <span className="mono rounded border border-border px-2 py-1 text-[10px] uppercase tracking-[0.08em]">
                          x402
                        </span>

                        <span className="mono rounded border border-border px-2 py-1 text-[10px] uppercase tracking-[0.08em]">
                          Algorand Testnet
                        </span>

                        <span className="mono rounded border border-border px-2 py-1 text-[10px] uppercase tracking-[0.08em]">
                          USDC
                        </span>

                      </div>
                    </div>
                  </div>
                </button>

              </div>
            </div>
          ) : null}

          {/* Payment error */}
          {paymentError ? (
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3 text-sm text-destructive">

              <div className="flex items-start gap-2">

                <FileWarning className="mt-0.5 size-4 shrink-0" />

                <div>
                  <p className="font-medium">
                    Payment / verification
                    failed
                  </p>

                  <p className="mt-1 text-xs">
                    {paymentError}
                  </p>
                </div>

              </div>
            </div>
          ) : null}

          {/* Payment success */}
          {paymentCompleted ? (
            <div className="mt-4 rounded-md border px-3 py-3 text-sm">

              <div className="flex items-start gap-2">

                <CheckCircle2
                  className="mt-0.5 size-4"
                  style={{
                    color:
                      "var(--ok)",
                  }}
                />

                <div>
                  <p className="font-medium">
                    Full Verification
                    unlocked
                  </p>

                  <p className="mt-1 text-xs text-muted-foreground">
                    Payment was verified
                    successfully on
                    Algorand Testnet.
                  </p>

                  {paymentTransaction ? (
                    <p className="mono mt-2 break-all text-[10px] text-muted-foreground">
                      Transaction:{" "}
                      {
                        paymentTransaction
                      }
                    </p>
                  ) : null}
                </div>

              </div>
            </div>
          ) : null}

          {/* Main button */}
          <div className="mt-6 flex flex-col gap-3">

            <button
              type="button"
              disabled={
                !prepared ||
                progress !==
                  null ||
                paying ||
                preparing
              }
              onClick={
                ingest
              }
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >

              {paying ? (
                <>
                  <CreditCard className="size-4 animate-pulse" />

                  Waiting for payment
                  verification…
                </>
              ) : progress !==
                null ? (
                <>
                  <UploadCloud className="size-4" />

                  Uploading…
                </>
              ) : verificationMode ===
                "full" ? (
                <>
                  <Lock className="size-4" />

                  Pay 0.01 USDC &
                  Verify
                </>
              ) : (
                <>
                  <CheckCircle2 className="size-4" />

                  Ingest & Analyse
                </>
              )}

            </button>

            <span className="text-center text-xs text-muted-foreground">
              {verificationMode ===
              "full"
                ? "Payment is requested through x402. Pera Wallet will ask you to approve the Algorand Testnet payment."
                : inputMode === "url"
                  ? "Use the pasted URL as evidence; Full Verification will reuse it for Source Trace automatically."
                  : "Upload an image from your device, then run the standard AI-generation assessment."}
            </span>

          </div>
        </Panel>

        {/* RIGHT */}
        <div className="space-y-4">

          {/* Wallet */}
          <Panel title="Verification wallet">

            <div className="space-y-3">

              {!activeAccount ? (
                <>
                  <div className="flex items-start gap-3 rounded-md border border-border bg-surface-2 p-3">

                    <Wallet className="mt-0.5 size-4 text-primary" />

                    <div>
                      <p className="text-sm font-medium">
                        Pera Wallet
                      </p>

                      <p className="mt-1 text-xs text-muted-foreground">
                        Connect your Pera Wallet
                        to purchase Full
                        Verification.
                      </p>
                    </div>

                  </div>

                  <button
                    type="button"
                    onClick={
                      connectWallet
                    }
                    className="w-full rounded-md border border-primary px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/5"
                  >
                    Connect Pera Wallet
                  </button>
                </>
              ) : (
                <>
                  <div className="rounded-md border border-border bg-surface-2 p-3">

                    <div className="flex items-center gap-2">

                      <CheckCircle2
                        className="size-4"
                        style={{
                          color:
                            "var(--ok)",
                        }}
                      />

                      <span className="text-sm font-medium">
                        Wallet connected
                      </span>

                    </div>

                    <p className="mono mt-2 break-all text-[10px] text-muted-foreground">
                      {
                        activeAccount.address
                      }
                    </p>

                  </div>

                  <button
                    type="button"
                    onClick={
                      disconnectWallet
                    }
                    className="w-full rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent"
                  >
                    Disconnect Wallet
                  </button>
                </>
              )}

            </div>
          </Panel>

          {/* Payment */}
          <Panel title="Full Verification payment">

            <div className="space-y-3 text-xs text-muted-foreground">

              <div className="flex items-center justify-between">
                <span>
                  Price
                </span>

                <span className="mono font-semibold text-foreground">
                  0.01 USDC
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span>
                  Network
                </span>

                <span className="mono text-[10px]">
                  Algorand Testnet
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span>
                  Protocol
                </span>

                <span className="mono">
                  x402
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span>
                  Settlement
                </span>

                <span className="mono">
                  GoPlausible
                </span>
              </div>

              <div className="border-t border-border pt-3">
                <p>
                  SACHSCAN does not receive or
                  store your private wallet key.
                  Pera Wallet signs the payment
                  transaction.
                </p>
              </div>

            </div>
          </Panel>

          {/* Validation */}
          <Panel title="Intake validation">

            <ul className="space-y-2 text-xs text-muted-foreground">

              <li>
                Images: decoded before
                transfer — corrupted or
                truncated files are rejected.
              </li>

              <li>
                Videos: container decoded for
                dimensions and duration; the
                first 60 seconds are analysed.
              </li>

              <li>
                Text: readable text is extracted
                from .txt, .md, .pdf and .docx.
              </li>

              <li>
                SHA-256 fingerprint is computed
                locally and stored with the
                evidence record.
              </li>

              <li>
                Full Verification uses an x402
                payment request before the paid
                response is released.
              </li>

            </ul>

          </Panel>

          <Disclaimer />

        </div>
      </div>
    </PageShell>
  );
}