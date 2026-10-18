import { createFileRoute } from "@tanstack/react-router";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const TINYFISH_FETCH_ENDPOINT = "https://api.fetch.tinyfish.ai";
const TINYFISH_SEARCH_ENDPOINT = "https://api.search.tinyfish.ai";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_SEARCH_QUERIES = 4;

interface SourceTraceRequest { investigationId: string; url: string }
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequestBody(body: unknown): SourceTraceRequest | null {
  if (!isRecord(body)) return null;
  const investigationId = body["investigationId"];
  const url = body["url"];
  if (typeof investigationId !== "string" || !investigationId.trim() || investigationId.length > 200 ||
      typeof url !== "string" || !url.trim() || url.length > 4096) return null;
  return { investigationId: investigationId.trim(), url: url.trim() };
}

function isPublicIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = -1, b = -1, c = -1] = p;
  if (a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224) return false;
  return true;
}

function isPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPublicIpv4(ip);
  if (version !== 6) return false;
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1" || v.startsWith("fe8") || v.startsWith("fe9") ||
      v.startsWith("fea") || v.startsWith("feb") || v.startsWith("fc") ||
      v.startsWith("fd") || v.startsWith("::ffff:") || v.startsWith("2001:db8:")) return false;
  // Only globally routable IPv6 unicast space is accepted.
  return v.startsWith("2") || v.startsWith("3");
}

async function validatePublicUrl(raw: string): Promise<URL | null> {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
  if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (isIP(host)) return isPublicIp(host) ? url : null;
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) return null;
  } catch { return null; }
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function collectStrings(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 7 || output.length > 500) return output;
  if (typeof value === "string") {
    if (value.length > 1 && value.length < 30_000) output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, depth + 1);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, output, depth + 1);
  }
  return output;
}

function unique<T>(items: T[]): T[] { return [...new Set(items)]; }

function makeQueries(sourceUrl: URL, fetchedPage: unknown): string[] {
  const strings = collectStrings(fetchedPage);
  const allText = strings.join("\n").replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ");
  const queries: string[] = [`"${sourceUrl.toString()}"`];
  const basename = decodeURIComponent(sourceUrl.pathname.split("/").pop() ?? "")
    .replace(/\.(jpe?g|png|webp|gif|avif|bmp|mp4|webm|mov)$/i, "")
    .replace(/[-_]+/g, " ").trim();
  if (basename.length >= 5 && !/^[a-f0-9]{20,}$/i.test(basename)) queries.push(`"${basename.slice(0, 100)}"`);

  // Use likely title / heading values when TinyFish includes structured page fields.
  const titleCandidates: string[] = [];
  const walk = (v: unknown, depth = 0) => {
    if (depth > 7) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (!isRecord(v)) return;
    for (const [key, val] of Object.entries(v)) {
      if (typeof val === "string" && /^(title|page_title|og:title|headline|description|meta_description)$/i.test(key) && val.trim().length >= 8) titleCandidates.push(val.trim());
      else walk(val, depth + 1);
    }
  };
  walk(fetchedPage);
  for (const title of titleCandidates.slice(0, 2)) queries.push(`"${title.slice(0, 180)}"`);

  // If no structured title is available, use a short, non-URL phrase from extracted page text.
  if (queries.length < 3 && allText.length >= 40) {
    const phrase = allText.replace(/[#>*`|{}\[\]]/g, " ").slice(0, 160).trim();
    if (phrase.length >= 30) queries.push(`"${phrase}"`);
  }
  return unique(queries.map((q) => q.trim()).filter(Boolean)).slice(0, MAX_SEARCH_QUERIES);
}

async function searchTinyFish(query: string, apiKey: string): Promise<{ query: string; data: unknown; warning: string | null }> {
  try {
    const searchUrl = new URL(TINYFISH_SEARCH_ENDPOINT);
    searchUrl.searchParams.set("query", query);
    searchUrl.searchParams.set("language", "en");
    searchUrl.searchParams.set("location", "IN");
    const response = await fetch(searchUrl.toString(), {
      method: "GET", headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await readJson(response);
    if (!response.ok) return { query, data: null, warning: `Search failed for query: ${query}` };
    return { query, data, warning: null };
  } catch {
    return { query, data: null, warning: `Search timed out or could not complete for query: ${query}` };
  }
}

export const Route = createFileRoute("/api/source-trace")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try { body = await request.json(); }
        catch { return Response.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
        const input = parseRequestBody(body);
        if (!input) return Response.json({ error: "Provide a valid investigation ID and source URL." }, { status: 400 });
        const sourceUrl = await validatePublicUrl(input.url);
        if (!sourceUrl) return Response.json({ error: "Provide a valid public HTTP or HTTPS URL. Private or non-public hosts are not allowed." }, { status: 400 });

        let signals: unknown;
        try {
          const { data, error } = await supabaseAdmin.from("analysis_results").select("signals")
            .eq("investigation_id", input.investigationId).order("created_at", { ascending: false }).limit(1).maybeSingle();
          if (error) {
            console.error("Source trace database lookup failed:", { code: error.code, message: error.message });
            return Response.json({ error: "Could not verify the investigation. Check the server terminal." }, { status: 500 });
          }
          if (!data) return Response.json({ error: "No analysis result was found for this investigation." }, { status: 404 });
          signals = data.signals;
        } catch (error) {
          console.error("Source trace lookup exception:", error);
          return Response.json({ error: "An unexpected error occurred while verifying the investigation." }, { status: 500 });
        }

        // Keep the existing paid Full Verification gate. Never remove this check.
        if (!isRecord(signals) || signals["verificationTier"] !== "full" || signals["verificationStatus"] !== "paid") {
          return Response.json({ error: "Source tracing is available only after paid Full Verification." }, { status: 403 });
        }
        const apiKey = process.env["TINYFISH_API_KEY"];
        if (!apiKey) {
          console.error("TINYFISH_API_KEY is not configured.");
          return Response.json({ error: "Source tracing is not configured on the server." }, { status: 503 });
        }

        let fetchData: unknown;
        try {
          const response = await fetch(TINYFISH_FETCH_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
            body: JSON.stringify({ urls: [sourceUrl.toString()], format: "markdown", links: true, image_links: true }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          fetchData = await readJson(response);
          if (!response.ok) {
            console.error("TinyFish Fetch failed:", { status: response.status });
            return Response.json({ error: "The source-fetching service failed. Check the server terminal." }, { status: 502 });
          }
        } catch (error) {
          console.error("TinyFish Fetch request failed:", error);
          return Response.json({ error: "Could not connect to the source-fetching service." }, { status: 502 });
        }

        const queries = makeQueries(sourceUrl, fetchData);
        const searchResults = await Promise.all(queries.map((query) => searchTinyFish(query, apiKey)));
        const searchWarnings = searchResults.filter((r) => r.warning).map((r) => r.warning as string);
        const successfulSearches = searchResults.filter((r) => r.data !== null);

        return Response.json({
          success: true,
          investigationId: input.investigationId,
          submittedUrl: sourceUrl.toString(),
          verificationTier: "full",
          sourceTracing: {
            fetch: fetchData,
            searches: searchResults,
            searchQueries: queries,
            warning: successfulSearches.length === 0 ? "No search query returned results. This is not evidence that the image has never appeared elsewhere." : (searchWarnings.length ? searchWarnings.join(" ") : null),
          },
          disclaimer: "Results are candidate indexed appearances based on page text, URL and available metadata. They are not pixel-based reverse-image matches and cannot establish the true first upload or original creator.",
        });
      },
    },
  },
});
