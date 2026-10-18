
import { createFileRoute } from "@tanstack/react-router";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "video/ogg",
]);

const MEDIA_ACCEPT = "image/*, video/*";

function isPublicIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);

  if (
    p.length !== 4 ||
    p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return false;
  }

  const [a = -1, b = -1, c = -1] = p;

  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  ) {
    return false;
  }

  return true;
}

function isPublicIp(ip: string): boolean {
  const version = isIP(ip);

  if (version === 4) {
    return isPublicIpv4(ip);
  }

  if (version !== 6) {
    return false;
  }

  const value = ip.toLowerCase();

  if (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("::ffff:") ||
    value.startsWith("2001:db8:")
  ) {
    return false;
  }

  return value.startsWith("2") || value.startsWith("3");
}

async function validatePublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid public media or webpage URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not supported.");
  }

  if (
    url.port &&
    !(
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    )
  ) {
    throw new Error("Only standard HTTP and HTTPS ports are supported.");
  }

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Private or local network URLs are not allowed.");
  }

  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new Error("Private or non-public IP addresses are not allowed.");
    }

    return url;
  }

  try {
    const addresses = await lookup(hostname, {
      all: true,
      verbatim: true,
    });

    if (
      !addresses.length ||
      addresses.some(({ address }) => !isPublicIp(address))
    ) {
      throw new Error(
        "The media host resolves to a private or non-public address.",
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("private or non-public")
    ) {
      throw error;
    }

    throw new Error("The media host could not be resolved.");
  }

  return url;
}

function normalizedType(response: Response): string {
  return (
    response.headers.get("content-type") ?? ""
  )
    .split(";")[0]
    ?.trim()
    .toLowerCase() ?? "";
}

function extensionFor(type: string): string {
  const extensions: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/x-matroska": ".mkv",
    "video/ogg": ".ogv",
  };

  return extensions[type] ?? ".bin";
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractMediaUrl(
  html: string,
  pageUrl: URL,
): string | null {
  const candidates: string[] = [];
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];

  for (const tag of metaTags) {
    const key = tag
      .match(/\b(?:property|name)\s*=\s*(["'])(.*?)\1/i)?.[2]
      ?.toLowerCase();

    const content = tag.match(
      /\bcontent\s*=\s*(["'])(.*?)\1/i,
    )?.[2];

    if (
      typeof content === "string" &&
      typeof key === "string" &&
      [
        "og:image",
        "og:image:url",
        "twitter:image",
        "twitter:image:src",
        "og:video",
        "og:video:url",
        "twitter:player:stream",
      ].includes(key)
    ) {
      candidates.push(decodeHtml(content.trim()));
    }
  }

  // Inspect JSON-LD structured data without executing page scripts.
  const jsonLdBlocks =
    html.match(
      /<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>[\s\S]*?<\/script>/gi,
    ) ?? [];

  for (const block of jsonLdBlocks) {
    const content = block
      .replace(/^<script\b[^>]*>/i, "")
      .replace(/<\/script>$/i, "");

    try {
      const parsed: unknown = JSON.parse(content);

      const walk = (value: unknown, depth = 0): void => {
        if (depth > 8 || candidates.length >= 50) {
          return;
        }

        if (
          value === null ||
          typeof value !== "object"
        ) {
          return;
        }

        if (Array.isArray(value)) {
          for (const item of value) {
            walk(item, depth + 1);
          }
          return;
        }

        const record = value as Record<string, unknown>;

        for (const [key, val] of Object.entries(record)) {
          const normalizedKey = key.toLowerCase();

          if (
            [
              "image",
              "contenturl",
              "thumbnailurl",
              "url",
              "video",
            ].includes(normalizedKey)
          ) {
            if (typeof val === "string" && val.trim()) {
              candidates.push(val.trim());
            } else if (Array.isArray(val)) {
              for (const item of val) {
                if (typeof item === "string" && item.trim()) {
                  candidates.push(item.trim());
                } else if (
                  item !== null &&
                  typeof item === "object" &&
                  !Array.isArray(item)
                ) {
                  const itemRecord =
                    item as Record<string, unknown>;

                  const itemUrl = itemRecord["url"];
                  const contentUrl = itemRecord["contentUrl"];

                  if (
                    typeof itemUrl === "string" &&
                    itemUrl.trim()
                  ) {
                    candidates.push(itemUrl.trim());
                  }

                  if (
                    typeof contentUrl === "string" &&
                    contentUrl.trim()
                  ) {
                    candidates.push(contentUrl.trim());
                  }
                }
              }
            } else if (
              val !== null &&
              typeof val === "object"
            ) {
              const nestedRecord =
                val as Record<string, unknown>;

              const nestedUrl = nestedRecord["url"];
              const nestedContentUrl = nestedRecord["contentUrl"];

              if (
                typeof nestedUrl === "string" &&
                nestedUrl.trim()
              ) {
                candidates.push(nestedUrl.trim());
              }

              if (
                typeof nestedContentUrl === "string" &&
                nestedContentUrl.trim()
              ) {
                candidates.push(nestedContentUrl.trim());
              }
            }
          }

          if (
            val !== null &&
            typeof val === "object"
          ) {
            walk(val, depth + 1);
          }
        }
      };

      walk(parsed);
    } catch {
      // Ignore malformed JSON-LD.
    }
  }

  for (const candidate of candidates) {
    try {
      const resolved = new URL(candidate, pageUrl);

      if (
        resolved.protocol === "https:" ||
        resolved.protocol === "http:"
      ) {
        return resolved.toString();
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

async function fetchNoRedirect(
  url: URL,
  accept: string,
): Promise<Response> {
  return fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: accept },
  });
}

async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const length = Number(
    response.headers.get("content-length") ?? 0,
  );

  if (Number.isFinite(length) && length > limit) {
    throw new Error(
      limit === MAX_MEDIA_BYTES
        ? "Media exceeds the 25 MB import limit."
        : "The webpage exceeds the page inspection limit.",
    );
  }

  if (!response.body) {
    throw new Error("The host returned an empty response.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      total += value.byteLength;

      if (total > limit) {
        await reader.cancel();

        throw new Error(
          limit === MAX_MEDIA_BYTES
            ? "Media exceeds the 25 MB import limit."
            : "The webpage exceeds the page inspection limit.",
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function responseForMedia(
  bytes: Uint8Array,
  type: string,
): Response {
  // Use a standalone ArrayBuffer for strict DOM BodyInit typings.
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.byteLength),
      "X-SACHSCAN-Filename": `url-evidence${extensionFor(type)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const Route = createFileRoute("/api/url-detection")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request
            .json()
            .catch(() => null)) as { url?: unknown } | null;

          if (
            typeof body?.url !== "string" ||
            !body.url.trim() ||
            body.url.length > 4096
          ) {
            return Response.json(
              { error: "Provide a valid media or webpage URL." },
              { status: 400 },
            );
          }

          const pageUrl = await validatePublicUrl(
            body.url.trim(),
          );

          // First try the URL as a direct media URL.
          const direct = await fetchNoRedirect(
            pageUrl,
            MEDIA_ACCEPT,
          );

          if (
            direct.status >= 300 &&
            direct.status < 400
          ) {
            return Response.json(
              {
                error:
                  "This URL redirects elsewhere. Please use the final direct media URL or a public page URL that does not redirect.",
              },
              { status: 400 },
            );
          }

          if (direct.ok) {
            const type = normalizedType(direct);

            if (ALLOWED_TYPES.has(type)) {
              const bytes = await readBounded(
                direct,
                MAX_MEDIA_BYTES,
              );

              return responseForMedia(bytes, type);
            }

            if (
              type &&
              !type.includes("text/html") &&
              !type.includes("application/xhtml+xml")
            ) {
              return Response.json(
                {
                  error:
                    "The URL did not return a supported image or video file.",
                },
                { status: 415 },
              );
            }
          } else if (
            direct.status !== 415 &&
            direct.status !== 400
          ) {
            if (
              direct.status < 400 ||
              direct.status >= 500
            ) {
              return Response.json(
                {
                  error: `The media host returned HTTP ${direct.status}.`,
                },
                { status: 502 },
              );
            }
          }

          // Try public HTML metadata if the URL was not direct media.
          const pageResponse = await fetchNoRedirect(
            pageUrl,
            "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          );

          if (
            pageResponse.status >= 300 &&
            pageResponse.status < 400
          ) {
            return Response.json(
              {
                error:
                  "This webpage redirects elsewhere. Paste the final public page URL.",
              },
              { status: 400 },
            );
          }

          if (!pageResponse.ok) {
            return Response.json(
              {
                error: `The webpage returned HTTP ${pageResponse.status}.`,
              },
              { status: 502 },
            );
          }

          const pageType = normalizedType(pageResponse);

          if (
            !pageType.includes("text/html") &&
            !pageType.includes("application/xhtml+xml")
          ) {
            return Response.json(
              {
                error:
                  "This URL is not a supported media file or an HTML webpage.",
              },
              { status: 415 },
            );
          }

          const pageBytes = await readBounded(
            pageResponse,
            MAX_PAGE_BYTES,
          );

          const html = new TextDecoder("utf-8", {
            fatal: false,
          }).decode(pageBytes);

          const mediaUrlText = extractMediaUrl(
            html,
            pageUrl,
          );

          if (!mediaUrlText) {
            return Response.json(
              {
                error:
                  "The page did not expose a supported preview image or video in public metadata. Try a direct media URL or upload the file from your device.",
              },
              { status: 415 },
            );
          }

          // Validate the extracted URL independently before fetching it.
          const mediaUrl = await validatePublicUrl(
            mediaUrlText,
          );

          const mediaResponse = await fetchNoRedirect(
            mediaUrl,
            MEDIA_ACCEPT,
          );

          if (
            mediaResponse.status >= 300 &&
            mediaResponse.status < 400
          ) {
            return Response.json(
              {
                error:
                  "The page's media URL redirects. Use a direct media URL or upload the file from your device.",
              },
              { status: 400 },
            );
          }

          if (!mediaResponse.ok) {
            return Response.json(
              {
                error: `The page's media host returned HTTP ${mediaResponse.status}.`,
              },
              { status: 502 },
            );
          }

          const mediaType = normalizedType(mediaResponse);

          if (!ALLOWED_TYPES.has(mediaType)) {
            return Response.json(
              {
                error:
                  "The page metadata points to a file that is not a supported image or video.",
              },
              { status: 415 },
            );
          }

          const mediaBytes = await readBounded(
            mediaResponse,
            MAX_MEDIA_BYTES,
          );

          return responseForMedia(mediaBytes, mediaType);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Could not import this URL.";

          return Response.json(
            { error: message },
            { status: 400 },
          );
        }
      },
    },
  },
});
