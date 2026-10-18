
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { SachscanLockup } from "@/components/forensic/logo";

import { WalletProvider } from "@txnlab/use-wallet-react";
import { WalletManager } from "@txnlab/use-wallet";
import { pera } from "@txnlab/use-wallet-pera";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="mono text-6xl font-semibold text-foreground">404</h1>
        <h2 className="mt-4 text-lg font-semibold">Resource not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The requested console route or case record does not exist.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md border border-border bg-surface-2 px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Return to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  console.error(error);
  const router = useRouter();

  useEffect(() => {
    reportLovableError(error, {
      boundary: "tanstack_root_error_component",
    });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-lg text-center">
        <h1 className="text-lg font-semibold tracking-tight">
          Console error
        </h1>

        <p className="mt-2 text-sm text-muted-foreground">
          This view failed to load. No case data has been altered.
        </p>

        <pre className="mono mt-4 max-h-40 overflow-auto rounded border border-border bg-surface p-3 text-left text-xs text-muted-foreground">
          {error.message}
        </pre>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Retry
          </button>

          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Dashboard
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route =
  createRootRouteWithContext<{ queryClient: QueryClient }>()({
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        {
          name: "viewport",
          content: "width=device-width, initial-scale=1",
        },
        {
          title: "SACHSCAN — Digital Media Forensics & Verification",
        },
        {
          name: "description",
          content:
            "SACHSCAN is a digital media forensic investigation console: verify the evidence, understand the media.",
        },
        {
          property: "og:title",
          content:
            "SACHSCAN — Digital Media Forensics & Verification",
        },
        {
          property: "og:description",
          content:
            "Forensic evidence and signals platform for images. Verify the evidence. Understand the media.",
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

      links: [
        {
          rel: "stylesheet",
          href: appCss,
        },
        {
          rel: "preconnect",
          href: "https://fonts.googleapis.com",
        },
        {
          rel: "preconnect",
          href: "https://fonts.gstatic.com",
          crossOrigin: "anonymous",
        },
        {
          rel: "stylesheet",
          href:
            "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
        },
        {
          rel: "icon",
          href: "/favicon.svg",
          type: "image/svg+xml",
        },
      ],
    }),

    shellComponent: RootShell,
    component: RootComponent,
    notFoundComponent: NotFoundComponent,
    errorComponent: ErrorComponent,
  });

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>

      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/investigations", label: "Investigations" },
  { to: "/investigations/new", label: "New Investigation" },
  { to: "/text-detection", label: "Text Detection" },
] as const;

const walletManager = new WalletManager({
  wallets: [pera()],
  defaultNetwork: "testnet",
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider manager={walletManager}>
        <div className="relative z-10 min-h-screen">
          <header className="no-print sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-5">
              <Link to="/" className="flex items-center gap-2.5">
                <SachscanLockup />
              </Link>

              <nav className="ml-auto flex items-center gap-1">
                {NAV.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    activeOptions={{
                      exact: item.to === "/",
                    }}
                    className="rounded px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    activeProps={{
                      className: "bg-surface-2 text-foreground",
                    }}
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
          </header>

          {/* Required: nested routes render here. */}
          <Outlet />

          <footer className="no-print mt-16 border-t border-border py-6">
            <div className="mx-auto max-w-[1400px] px-5 text-[11px] text-muted-foreground">
              SACHSCAN — Investigate. Verify. Understand. Prototype
              forensic assessment — results are probabilistic indicators,
              not a definitive determination.
            </div>
          </footer>
        </div>

        <Toaster position="top-right" />
      </WalletProvider>
    </QueryClientProvider>
  );
}
