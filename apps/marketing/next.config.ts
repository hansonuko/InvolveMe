import type { NextConfig } from 'next';

// Static export — this app has zero API routes and zero middleware
// (verified before choosing this, not assumed), so there's no server-side
// Next.js feature here that a plain static host can't serve. Deploys to
// Cloudflare Pages as a plain static site (docs/15-MARKETING-SITE-PWA-SCOPING.md
// §7), not via Cloudflare's Next.js runtime adapter — no reason to take on
// that adapter's extra moving parts for an app with nothing dynamic in it.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'export',
};

export default nextConfig;
