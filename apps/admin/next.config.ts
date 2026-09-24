import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Server-only surface — the service-role key and admin session secret must
  // never reach a client bundle. No env vars are exposed via `env` here;
  // anything the browser needs gets its own explicit NEXT_PUBLIC_* var,
  // added only when a real feature phase needs one (none does yet).
  reactStrictMode: true,
  // lucide-react is a large barrel-file package (2000+ named exports from
  // one module) — Next.js's own docs name it directly as the standard
  // example for this option. Without it, Turbopack's dev bundler failed
  // to resolve individual icon imports at all (every icon came back
  // `undefined` at runtime despite resolving fine in plain Node ESM/CJS —
  // a barrel-interop bug, not a missing/renamed export), not just a
  // bundle-size/cold-start cost as the docs' own framing might suggest.
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
};

export default nextConfig;
