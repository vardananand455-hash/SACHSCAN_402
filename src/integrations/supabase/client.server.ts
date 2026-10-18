import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

function isNewSupabaseApiKey(value: string): boolean {
  return (
    value.startsWith("sb_publishable_") ||
    value.startsWith("sb_secret_")
  );
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request
        ? input.headers
        : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }

    // New Supabase API keys are opaque strings, not bearer JWTs.
    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }

    headers.set("apikey", supabaseKey);

    return fetch(input, {
      ...init,
      headers,
    });
  };
}

function createSupabaseServerClient() {
  const SUPABASE_URL = process.env["SUPABASE_URL"];
  const SUPABASE_PUBLISHABLE_KEY =
    process.env["SUPABASE_PUBLISHABLE_KEY"];

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    const missing = [
      ...(!SUPABASE_URL ? ["SUPABASE_URL"] : []),
      ...(!SUPABASE_PUBLISHABLE_KEY
        ? ["SUPABASE_PUBLISHABLE_KEY"]
        : []),
    ];

    throw new Error(
      `Missing Supabase environment variable(s): ${missing.join(", ")}`,
    );
  }

  return createClient<Database>(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    {
      global: {
        fetch: createSupabaseFetch(SUPABASE_PUBLISHABLE_KEY),
      },
      auth: {
        storage: undefined,
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

let _supabaseServer:
  | ReturnType<typeof createSupabaseServerClient>
  | undefined;

/**
 * Server-side Supabase client.
 *
 * This client uses the publishable key, so it does NOT bypass RLS.
 * Database and storage access is therefore controlled by the
 * policies configured in Supabase.
 *
 * Keep this module server-only.
 */
export const supabaseAdmin = new Proxy(
  {} as ReturnType<typeof createSupabaseServerClient>,
  {
    get(_, prop, receiver) {
      if (!_supabaseServer) {
        _supabaseServer = createSupabaseServerClient();
      }

      return Reflect.get(_supabaseServer, prop, receiver);
    },
  },
);