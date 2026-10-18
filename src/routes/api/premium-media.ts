import { createFileRoute } from "@tanstack/react-router";
import { x402HTTPResourceServer } from "@x402/core/http";

import {
  x402Server,
  premiumAnalysisPayment,
} from "@/lib/x402.server";

import {
  analyzeBytes,
  sha256Hex,
} from "@/lib/forensics.server";

import {
  detectAiGenerated,
  applyAiDetection,
} from "@/lib/sightengine.server";

import { supabaseAdmin } from "@/integrations/supabase/client.server";

/*
 * ============================================================
 * SACHSCAN FULL VERIFICATION — x402 PAID ENDPOINT
 * ============================================================
 *
 * This endpoint is ONLY for Full Verification.
 *
 * Payment:
 *   x402
 *   Algorand Testnet
 *   USDC
 *
 * Full analysis:
 *   - SACHSCAN forensic engine
 *   - Sightengine AI detection
 *   - EXIF / XMP
 *   - JPEG analysis
 *   - Pixel analysis
 *   - C2PA
 *   - Manipulation analysis
 *   - Regional analysis
 *   - Heatmap data
 *   - Detailed findings
 *
 * IMPORTANT:
 * The result is saved with:
 *
 *   verificationTier: "full"
 *
 * This is what the frontend uses to distinguish
 * Full Verification from Standard Verification.
 * ============================================================
 */

const httpServer = new x402HTTPResourceServer(
  x402Server,
  {
    "POST /api/premium-media": {
      accepts: premiumAnalysisPayment,
      description: "SACHSCAN Full Verification",
      mimeType: "application/json",
    },
  },
);

let initialized: Promise<void> | undefined;

function ensureInitialized() {
  if (!initialized) {
    initialized = httpServer.initialize();
  }

  return initialized;
}

/*
 * ============================================================
 * RESPONSE HELPER
 * ============================================================
 */

function createResponse(response: {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  return new Response(
    response.body === undefined
      ? undefined
      : JSON.stringify(response.body),
    {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        ...(response.headers ?? {}),
      },
    },
  );
}

/*
 * ============================================================
 * MIME TYPE
 * ============================================================
 *
 * Supabase may sometimes return:
 *
 * application/octet-stream
 *
 * so we determine the MIME type from the filename
 * when necessary.
 * ============================================================
 */

function getMimeType(fileName: string): string {
  const extension =
    fileName
      .split(".")
      .pop()
      ?.toLowerCase() ?? "";

  switch (extension) {
    /*
     * -------------------------
     * Images
     * -------------------------
     */

    case "jpg":
    case "jpeg":
      return "image/jpeg";

    case "png":
      return "image/png";

    case "webp":
      return "image/webp";

    case "gif":
      return "image/gif";

    case "bmp":
      return "image/bmp";

    case "tif":
    case "tiff":
      return "image/tiff";

    case "avif":
      return "image/avif";

    /*
     * -------------------------
     * Videos
     * -------------------------
     */

    case "mp4":
      return "video/mp4";

    case "mov":
      return "video/quicktime";

    case "webm":
      return "video/webm";

    case "avi":
      return "video/x-msvideo";

    case "mkv":
      return "video/x-matroska";

    case "m4v":
      return "video/x-m4v";

    default:
      return "application/octet-stream";
  }
}

/*
 * ============================================================
 * ROUTE
 * ============================================================
 */

export const Route = createFileRoute(
  "/api/premium-media",
)({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          /*
           * ==================================================
           * INITIALIZE x402
           * ==================================================
           */

          await ensureInitialized();

          /*
           * ==================================================
           * x402 REQUEST ADAPTER
           * ==================================================
           */

          const adapter = {
            getMethod: () => request.method,

            getUrl: () => request.url,

            getPath: () =>
              new URL(request.url).pathname,

            getHeader: (name: string) =>
              request.headers.get(name) ??
              undefined,

            getAcceptHeader: () =>
              request.headers.get("accept") ??
              "",

            getUserAgent: () =>
              request.headers.get("user-agent") ??
              "",
          };

          const context = {
            adapter,
            path: new URL(request.url).pathname,
            method: request.method,
          };

          /*
           * ==================================================
           * 1. PROCESS x402 PAYMENT
           * ==================================================
           */

          const paymentResult =
            await httpServer.processHTTPRequest(
              context,
            );

          /*
           * No valid payment yet.
           *
           * x402 returns HTTP 402.
           */

          if (
            paymentResult.type ===
            "payment-error"
          ) {
            return createResponse(
              paymentResult.response,
            );
          }

          /*
           * This endpoint must require payment.
           */

          if (
            paymentResult.type ===
            "no-payment-required"
          ) {
            return new Response(
              JSON.stringify({
                error:
                  "Payment route configuration error",
              }),
              {
                status: 500,
                headers: {
                  "Content-Type":
                    "application/json",
                },
              },
            );
          }

          /*
           * ==================================================
           * 2. READ REQUEST BODY
           * ==================================================
           */

          let body: unknown;

          try {
            body = await request.json();
          } catch {
            return new Response(
              JSON.stringify({
                error:
                  "Invalid JSON request body.",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type":
                    "application/json",
                },
              },
            );
          }

          if (
            typeof body !== "object" ||
            body === null
          ) {
            return new Response(
              JSON.stringify({
                error:
                  "Request body is required.",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type":
                    "application/json",
                },
              },
            );
          }

          const requestBody =
            body as {
              investigationId?: unknown;
              storagePath?: unknown;
            };

          const investigationId =
            requestBody.investigationId;

          const storagePath =
            requestBody.storagePath;

          /*
           * ==================================================
           * 3. VALIDATE INVESTIGATION ID
           * ==================================================
           */

          if (
            typeof investigationId !==
              "string" ||
            !investigationId.trim()
          ) {
            return new Response(
              JSON.stringify({
                error:
                  "investigationId is required.",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type":
                    "application/json",
                },
              },
            );
          }

          /*
           * ==================================================
           * 4. VALIDATE STORAGE PATH
           * ==================================================
           */

          if (
            typeof storagePath !==
              "string" ||
            !storagePath.trim()
          ) {
            return new Response(
              JSON.stringify({
                error:
                  "storagePath is required.",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type":
                    "application/json",
                },
              },
            );
          }

          /*
           * ==================================================
           * 5. DOWNLOAD EVIDENCE
           * ==================================================
           */

          const download =
            await supabaseAdmin.storage
              .from("evidence")
              .download(
                storagePath.trim(),
              );

          if (
            download.error ||
            !download.data
          ) {
            return new Response(
              JSON.stringify({
                error:
                  "Evidence file could not be retrieved.",
                details:
                  download.error?.message ??
                  "Unknown storage error.",
              }),
              {
                status: 500,
                headers: {
                  "Content-Type":
                    "application/json",
                },
              },
            );
          }

          const bytes =
            new Uint8Array(
              await download.data.arrayBuffer(),
            );

          if (bytes.length === 0) {
            return new Response(
              JSON.stringify({
                error:
                  "Evidence file is empty.",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type":
                    "application/json",
                },
              },
            );
          }

          /*
           * ==================================================
           * 6. FINGERPRINT EVIDENCE
           * ==================================================
           */

          const fileHash =
            await sha256Hex(bytes);

          /*
           * ==================================================
           * 7. GET FILE NAME
           * ==================================================
           */

          const fileName =
            storagePath
              .trim()
              .split("/")
              .pop() ?? "evidence";

          /*
           * ==================================================
           * 8. DETERMINE MIME TYPE
           * ==================================================
           *
           * Sightengine needs the correct media type
           * because images and videos use different
           * endpoints.
           */

          const contentType =
            download.data.type &&
            download.data.type !==
              "application/octet-stream"
              ? download.data.type
              : getMimeType(fileName);

          console.log(
            "[SACHSCAN] Premium verification:",
            {
              fileName,
              contentType,
              bytes: bytes.length,
            },
          );

          /*
           * ==================================================
           * 9. RUN SACHSCAN FORENSIC ENGINE
           * ==================================================
           *
           * This produces the detailed forensic report.
           */

          const forensicReport =
            await analyzeBytes(
              bytes,
              fileName,
            );

          /*
           * ==================================================
           * 10. RUN SIGHTENGINE AI DETECTION
           * ==================================================
           *
           * Sightengine provides the paid AI-generation
           * probability.
           */

          const sightengine =
            await detectAiGenerated(
              bytes,
              fileName,
              contentType,
            );

          console.log(
            "[SACHSCAN] Sightengine result:",
            {
              mediaKind:
                sightengine.mediaKind,

              rawScore:
                sightengine.rawScore,

              aiProbability:
                sightengine.aiProbability,

              topGenerator:
                sightengine.topGenerator
                  ?.name ?? null,
            },
          );

          /*
           * ==================================================
           * 11. COMBINE SIGHTENGINE + SACHSCAN
           * ==================================================
           *
           * Sightengine:
           *   AI-generation detection
           *
           * SACHSCAN:
           *   forensic/manipulation evidence
           */

          const forensicWithAi =
            applyAiDetection(
              forensicReport,
              sightengine,
            );

          /*
           * ==================================================
           * 12. MARK THIS ANALYSIS AS FULL
           * ==================================================
           *
           * THIS IS THE IMPORTANT FIX.
           *
           * The verification tier is stored INSIDE
           * the analysis JSON.
           *
           * The frontend can therefore reliably determine:
           *
           *   standard
           *   vs
           *   full
           *
           * without guessing from Sightengine.
           */

          const analysis = {
            ...forensicWithAi,

            verificationTier:
              "full" as const,

            verificationStatus:
              "paid" as const,

            paymentProvider:
              "x402",

            paymentNetwork:
              paymentResult
                .paymentRequirements
                .network,
          };

          /*
           * ==================================================
           * 13. SAVE ANALYSIS RESULT
           * ==================================================
           */

          const {
            error:
              analysisInsertError,
          } =
            await supabaseAdmin
              .from(
                "analysis_results",
              )
              .insert({
                investigation_id:
                  investigationId.trim(),

                file_hash:
                  fileHash,

                ai_probability:
                  analysis.aiProbability,

                manipulation_probability:
                  analysis.manipulationProbability,

                authenticity_confidence:
                  analysis.authenticityConfidence,

                risk_level:
                  analysis.riskLevel,

                findings:
                  analysis.findings as never,

                /*
                 * IMPORTANT:
                 *
                 * The complete analysis object
                 * now contains:
                 *
                 * verificationTier: "full"
                 *
                 */
                signals:
                  analysis as never,
              });

          if (
            analysisInsertError
          ) {
            console.error(
              "[SACHSCAN] analysis_results insert failed:",
              analysisInsertError,
            );

            return new Response(
              JSON.stringify({
                error:
                  `Analysis results could not be saved: ${analysisInsertError.message}`,
              }),
              {
                status: 500,
                headers: {
                  "Content-Type":
                    "application/json",
                },
              },
            );
          }

          /*
           * ==================================================
           * 14. UPDATE INVESTIGATION
           * ==================================================
           */

          const {
            error:
              investigationUpdateError,
          } =
            await supabaseAdmin
              .from(
                "investigations",
              )
              .update({
                status: "complete",

                ai_probability:
                  analysis.aiProbability,

                manipulation_probability:
                  analysis.manipulationProbability,

                authenticity_confidence:
                  analysis.authenticityConfidence,

                risk_level:
                  analysis.riskLevel,

                metadata_status:
                  analysis.metadataStatus,

                source_trace_status:
                  "NOT_AVAILABLE",

                summary:
                  analysis.summary,
              })
              .eq(
                "id",
                investigationId.trim(),
              );

          if (
            investigationUpdateError
          ) {
            console.error(
              "[SACHSCAN] investigation update failed:",
              investigationUpdateError,
            );

            return new Response(
              JSON.stringify({
                error:
                  `Investigation record could not be updated: ${investigationUpdateError.message}`,
              }),
              {
                status: 500,
                headers: {
                  "Content-Type":
                    "application/json",
                },
              },
            );
          }

          /*
           * ==================================================
           * 15. SETTLE x402 PAYMENT
           * ==================================================
           */

          const transportContext = {
            request: context,
          };

          const settlement =
            await httpServer.processSettlement(
              paymentResult.paymentPayload,
              paymentResult.paymentRequirements,
              paymentResult.declaredExtensions,
              transportContext,
            );

          if (!settlement.success) {
            return createResponse(
              settlement.response,
            );
          }

          /*
           * ==================================================
           * 16. SUCCESSFUL PAID VERIFICATION
           * ==================================================
           */

          return new Response(
            JSON.stringify({
              success: true,

              /*
               * Complete paid analysis
               */
              analysis,

              /*
               * Explicit Sightengine information
               */
              aiDetection: {
                provider:
                  sightengine.mediaKind ===
                  "video"
                    ? "Sightengine genai (video)"
                    : "Sightengine genai",

                aiProbability:
                  sightengine.aiProbability,

                rawScore:
                  sightengine.rawScore,

                mediaKind:
                  sightengine.mediaKind,

                topGenerator:
                  sightengine.topGenerator,

                generators:
                  sightengine.generators,
              },

              /*
               * Explicit Full Verification
               * status returned to frontend.
               */
              verification: {
                status: "paid",

                tier: "full",

                provider: "x402",

                network:
                  paymentResult
                    .paymentRequirements
                    .network,

                transaction:
                  settlement.transaction,
              },
            }),
            {
              status: 200,

              headers: {
                "Content-Type":
                  "application/json",

                ...settlement.headers,
              },
            },
          );
        } catch (error) {
          console.error(
            "[SACHSCAN] premium-media failed:",
            error,
          );

          return new Response(
            JSON.stringify({
              error:
                error instanceof Error
                  ? error.message
                  : "Full Verification failed.",
            }),
            {
              status: 500,
              headers: {
                "Content-Type":
                  "application/json",
              },
            },
          );
        }
      },
    },
  },
});