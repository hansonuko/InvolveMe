'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ThemeToggle } from '@/components/ThemeToggle';

const LINKS = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/guide', label: 'Guide' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/security', label: 'Security & Trust' },
  { href: '/download', label: 'Download' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
];

export function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="text-brand font-extrabold tracking-wide text-foreground-accent">
          InvolveMe
        </Link>

        <ul className="hidden items-center gap-8 md:flex">
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="text-body text-muted transition-colors hover:text-foreground"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-3">
          <ThemeToggle />

          <Link
            href="/signup"
            className="hidden rounded-pill bg-accent px-5 py-2 text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed md:inline-block"
          >
            Sign Up
          </Link>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Toggle menu"
            className="flex h-11 w-11 items-center justify-center rounded-card border border-border md:hidden"
          >
            <span className="sr-only">Menu</span>
            <div className="flex flex-col gap-1.5">
              <span className="block h-0.5 w-5 bg-foreground" />
              <span className="block h-0.5 w-5 bg-foreground" />
              <span className="block h-0.5 w-5 bg-foreground" />
            </div>
          </button>
        </div>
      </nav>

      {open ? (
        <ul className="flex flex-col gap-1 border-t border-border px-6 pb-4 md:hidden">
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={() => setOpen(false)}
                className="block py-3 text-body text-foreground"
              >
                {link.label}
              </Link>
            </li>
          ))}
          <li>
            <Link
              href="/signup"
              onClick={() => setOpen(false)}
              className="block py-3 text-body font-semibold text-foreground-accent"
            >
              Sign Up
            </Link>
          </li>
        </ul>
      ) : null}
    </header>
  );
}
