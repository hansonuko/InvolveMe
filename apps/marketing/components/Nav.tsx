'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { LogoMark } from '@/components/LogoMark';
import { ThemeToggle } from '@/components/ThemeToggle';

const GROUPS = [
  {
    label: 'Product',
    links: [
      { href: '/how-it-works', label: 'How it works' },
      { href: '/guide', label: 'Guide' },
      { href: '/pricing', label: 'Pricing' },
    ],
  },
  {
    label: 'Company',
    links: [
      { href: '/about', label: 'About' },
      { href: '/security', label: 'Security & Trust' },
      { href: '/contact', label: 'Contact' },
    ],
  },
];

const STANDALONE = { href: '/download', label: 'Download' };

// Flat list for the mobile drawer only — a vertical drawer has no crowding
// problem, so it doesn't need the Product/Company grouping the desktop
// bar does.
const ALL_LINKS = [...GROUPS.flatMap((g) => g.links), STANDALONE];

function NavDropdown({
  label,
  links,
}: {
  label: string;
  links: { href: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className="flex items-center gap-1.5 text-body text-muted transition-colors hover:text-foreground"
      >
        {label}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path
            d="M1 3l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div className="absolute left-0 top-full mt-3 min-w-[180px] rounded-card border border-border bg-surface py-2 shadow-lg">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-body text-foreground transition-colors hover:bg-surface-alt"
            >
              {link.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Nav() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 text-brand font-extrabold tracking-wide text-foreground-accent"
        >
          <LogoMark size={40} />
          InvolveMe
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {GROUPS.map((group) => (
            <NavDropdown key={group.label} label={group.label} links={group.links} />
          ))}
          <Link
            href={STANDALONE.href}
            className="text-body text-muted transition-colors hover:text-foreground"
          >
            {STANDALONE.label}
          </Link>
        </div>

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
            onClick={() => setMobileOpen((v) => !v)}
            aria-expanded={mobileOpen}
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

      {mobileOpen ? (
        <ul className="flex flex-col gap-1 border-t border-border px-6 pb-4 md:hidden">
          {ALL_LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="block py-3 text-body text-foreground"
              >
                {link.label}
              </Link>
            </li>
          ))}
          <li>
            <Link
              href="/signup"
              onClick={() => setMobileOpen(false)}
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
