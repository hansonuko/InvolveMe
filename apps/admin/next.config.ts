import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Server-only surface — the service-role key and admin session secret must
  // never reach a client bundle. No env vars are exposed via `env` here;
  // anything the browser needs gets its own explicit NEXT_PUBLIC_* var,
  // added only when a real feature phase needs one (none does yet).
  reactStrictMode: true,
};

export default nextConfig;
