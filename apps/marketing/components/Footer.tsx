import Link from 'next/link';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '/how-it-works', label: 'How it works' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/security', label: 'Security & Trust' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '/about', label: 'About' },
      { href: '/contact', label: 'Contact' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { href: '/legal/terms', label: 'Terms of Service' },
      { href: '/legal/privacy', label: 'Privacy Policy' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 md:grid-cols-[1.2fr_1fr_1fr_1fr]">
        <div>
          <p className="text-title font-extrabold text-foreground-accent">InvolveMe</p>
          <p className="mt-3 max-w-xs text-caption text-muted">
            A chat app where every message has real value: pay only for the conversations worth
            having.
          </p>
        </div>

        {COLUMNS.map((column) => (
          <div key={column.title}>
            <p className="text-caption font-semibold uppercase tracking-wide text-muted">
              {column.title}
            </p>
            <ul className="mt-4 flex flex-col gap-3">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-body text-foreground transition-colors hover:text-foreground-accent"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-border px-6 py-6 text-center text-caption text-muted">
        © {new Date().getFullYear()} InvolveMe. All rights reserved.
      </div>
    </footer>
  );
}
