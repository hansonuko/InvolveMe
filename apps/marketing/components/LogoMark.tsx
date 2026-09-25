// Inline SVG, not a rasterized PNG — guarantees pixel-perfect crispness at
// any display size/DPI (the earlier PNG-based nav mark looked soft/small at
// 32px). Uses currentColor for both bubble outlines and the "im" text, so
// wrapping it in the same `text-foreground-accent` class the "InvolveMe"
// wordmark already uses (wine in light mode, white in dark mode per
// docs/04-DESIGN-SYSTEM.md §1) makes it theme-adaptive automatically, no
// separate light/dark asset needed. No background square/box on purpose —
// that treatment belongs to the favicon (app/icon.png) and the mobile app
// icon, not an in-page nav mark sitting directly on the page's own surface.
export function LogoMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <mask id="logo-mark-bubble-cutout">
          <rect width="512" height="512" fill="#FFFFFF" />
          <circle cx="236" cy="225" r="95" fill="#000000" />
        </mask>
      </defs>
      <g mask="url(#logo-mark-bubble-cutout)">
        <path
          d="M 330 195 C 370 195 400 225 400 262 C 400 285 388 305 370 317 L 376 345 L 346 332 C 341 334 335 335 330 335 C 290 335 260 305 260 262 C 260 225 290 195 330 195 Z"
          stroke="currentColor"
          strokeWidth="22"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <path
        d="M 236 148 C 280 148 316 182 316 225 C 316 268 280 302 236 302 C 224 302 212 299 201 294 L 165 310 L 175 276 C 163 262 156 244 156 225 C 156 182 192 148 236 148 Z"
        stroke="currentColor"
        strokeWidth="22"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x="236"
        y="222"
        fill="currentColor"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        fontSize="76"
        fontWeight="900"
        textAnchor="middle"
        dominantBaseline="central"
        letterSpacing="-2"
      >
        im
      </text>
    </svg>
  );
}
