import { createFileRoute } from "@tanstack/react-router";
import { x402HTTPResourceServer } from "@x402/core/http";

import {
  x402Server,
  premiumAnalysisPayment,
} from "@/lib/x402.server";

import { detectAiText } from "@/lib/text-detection.server";

const httpServer = new x402HTTPResourceServer(x402Server, {
  "POST /api/premium-text": {
    accepts: premiumAnalysisPayment,
    description: "SACHSCAN Full Verification",
    mimeType: "application/json",
  },
});

let initialized: Promise<void> | undefined;

function ensureInitialized() {
  if (!initialized) {
    initialized = httpServer.initialize();
  }

  return initialized;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
  });
}

export const Route = createFileRoute("/api/premium-text")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        /*
         * IMPORTANT:
         * Keep the entire payment + verification flow inside
         * a try/catch so server-side errors are returned as
         * JSON instead of TanStack's generic HTTP 500 page.
         */
        try {
          /*
           * --------------------------------------------------
           * 1. Initialize x402
           * --------------------------------------------------
           */
          await ensureInitialized();

          /*
           * --------------------------------------------------
           * 2. Build the HTTP adapter expected by x402
           * --------------------------------------------------
           */
          const adapter = {
            getMethod: () => request.method,

            getUrl: () => request.url,

            getPath: () =>
              new URL(request.url).pathname,

            getHeader: (name: string) =>
              request.headers.get(name) ?? undefined,

            getAcceptHeader: () =>
              request.headers.get("accept") ?? "",

            getUserAgent: () =>
              request.headers.get("user-agent") ?? "",
          };

          const context = {
            adapter,
            path: new URL(request.url).pathname,
            method: request.method,
          };

          /*
           * --------------------------------------------------
           * 3. Process x402 payment request
           * --------------------------------------------------
           */
          const paymentResult =
            await httpServer.processHTTPRequest(
              context,
            );

          /*
           * No valid payment yet.
           *
           * x402 returns the HTTP 402 response containing
           * payment requirements here.
           */
          if (
            paymentResult.type ===
            "payment-error"
          ) {
            return new Response(
              paymentResult.response.body
                ? JSON.stringify(
                    paymentResult.response.body,
                  )
                : undefined,
              {
                status:
                  paymentResult.response.status,
                headers: {
                  "Content-Type":
                    "application/json",
                  ...(paymentResult.response
                    .headers ?? {}),
                },
              },
            );
          }

          /*
           * This route is supposed to require payment.
           */
          if (
            paymentResult.type ===
            "no-payment-required"
          ) {
            console.error(
              "[premium-text] x402 returned no-payment-required",
            );

            return jsonResponse(
              {
                error:
                  "Payment route configuration error",
              },
              500,
            );
          }

          /*
           * --------------------------------------------------
           * 4. Parse request body
           * --------------------------------------------------
           */
          let body: unknown;

          try {
            body = await request.json();
          } catch (error) {
            console.error(
              "[premium-text] Failed to parse JSON body:",
              error,
            );

            return jsonResponse(
              {
                error:
                  "Invalid JSON request body.",
              },
              400,
            );
          }

          /*
           * --------------------------------------------------
           * 5. Validate text
           * --------------------------------------------------
           */
          if (
            typeof body !== "object" ||
            body === null ||
            typeof (
              body as { text?: unknown }
            ).text !== "string"
          ) {
            return jsonResponse(
              {
                error: "Text is required",
              },
              400,
            );
          }

          const text = (
            body as { text: string }
          ).text.trim();

          const wordCount = text
            .split(/\s+/)
            .filter(Boolean).length;

          if (wordCount < 25) {
            return jsonResponse(
              {
                error:
                  "Please provide at least 25 words.",
              },
              400,
            );
          }

          /*
           * --------------------------------------------------
           * 6. Run the actual AI text detector
           * --------------------------------------------------
           *
           * If this throws, the catch block below will now
           * return the REAL error as JSON instead of a generic
           * HTML HTTP 500 response.
           */
          let analysis;

          try {
            console.log(
              `[premium-text] Running AI text detection (${wordCount} words)...`,
            );

            analysis = await detectAiText(text);

            console.log(
              "[premium-text] AI text detection completed.",
            );
          } catch (error) {
            console.error(
              "[premium-text] detectAiText() failed:",
              error,
            );

            const message =
              error instanceof Error
                ? error.message
                : String(error);

            return jsonResponse(
              {
                error:
                  "AI text detection failed.",
                details: message,
              },
              500,
            );
          }

          /*
           * --------------------------------------------------
           * 7. Settle the x402 payment
           * --------------------------------------------------
           */
          const transportContext = {
            request: context,
          };

          let settlement;

          try {
            console.log(
              "[premium-text] Settling x402 payment...",
            );

            settlement =
              await httpServer.processSettlement(
                paymentResult.paymentPayload,
                paymentResult.paymentRequirements,
                paymentResult.declaredExtensions,
                transportContext,
              );

            console.log(
              "[premium-text] Settlement response:",
              settlement,
            );
          } catch (error) {
            console.error(
              "[premium-text] Settlement threw an error:",
              error,
            );

            const message =
              error instanceof Error
                ? error.message
                : String(error);

            return jsonResponse(
              {
                error:
                  "Payment settlement failed.",
                details: message,
              },
              500,
            );
          }

          /*
           * --------------------------------------------------
           * 8. Handle settlement failure
           * --------------------------------------------------
           */
          if (!settlement.success) {
            console.error(
              "[premium-text] Payment settlement failed:",
              settlement,
            );

            return jsonResponse(
              {
                error:
                  "Payment settlement failed.",
                reason:
                  "errorReason" in settlement
                    ? settlement.errorReason
                    : undefined,
                details:
                  "errorMessage" in settlement
                    ? settlement.errorMessage
                    : undefined,
              },
              402,
            );
          }

          /*
           * --------------------------------------------------
           * 9. Successful paid verification
           * --------------------------------------------------
           */
          return new Response(
            JSON.stringify({
              success: true,

              analysis,

              verification: {
                status: "paid",

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
          /*
           * --------------------------------------------------
           * GLOBAL ERROR HANDLER
           * --------------------------------------------------
           *
           * This prevents TanStack from returning its own
           * non-JSON 500 page.
           */
          console.error(
            "[premium-text] UNHANDLED SERVER ERROR:",
            error,
          );

          const message =
            error instanceof Error
              ? error.message
              : String(error);

          return jsonResponse(
            {
              error:
                "Premium verification failed.",
              details: message,
            },
            500,
          );
        }
      },
    },
  },
});