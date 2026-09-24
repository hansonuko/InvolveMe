'use client';

import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  Landmark,
  ShieldAlert,
  Flag,
  Tags,
  ListChecks,
  UserCog,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  Menu,
  X,
} from 'lucide-react';
import { logoutAction } from '@/app/actions/auth';
import { ThemeToggle } from '@/components/ThemeToggle';

// A component TYPE (not yet rendered as an element) can't be handed from
// a Server Component to a Client Component as a plain prop value —
// confirmed the hard way: "Functions cannot be passed directly to Client
// Components." Only serializable data (a string key) crosses that
// boundary; the actual icon lookup has to live here, client-side, next to
// where it's rendered — (dashboard)/layout.tsx (a Server Component) only
// ever passes the key.
export const NAV_ICON_MAP = {
  dashboard: LayoutDashboard,
  users: Users,
  treasury: Landmark,
  fraudSignals: ShieldAlert,
  userReports: Flag,
  pricing: Tags,
  pendingActions: ListChecks,
  admins: UserCog,
};
export type NavIconKey = keyof typeof NAV_ICON_MAP;

export type NavItem = { href: string; label: string };
export type NavGroup = {
  href: string;
  label: string;
  icon: NavIconKey;
  children?: NavItem[];
};

const COLLAPSE_STORAGE_KEY = 'involveme-admin-sidebar-collapsed';
const COLLAPSE_CHANGE_EVENT = 'involveme-sidebar-collapse-change';

// SSR always renders expanded (the server has no way to know a prior
// localStorage choice) — useSyncExternalStore's server/client snapshot
// split is what lets the client read the real stored value on its very
// first render without a hydration-mismatch warning, same reasoning as
// ThemeToggle's mounted check. A custom window event (not the native
// 'storage' event, which only fires in *other* tabs) is what makes a
// same-tab toggle re-render immediately.
function useCollapsed(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(COLLAPSE_CHANGE_EVENT, onChange);
      return () => window.removeEventListener(COLLAPSE_CHANGE_EVENT, onChange);
    },
    () => localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1',
    () => false,
  );
}

function setCollapsed(value: boolean) {
  localStorage.setItem(COLLAPSE_STORAGE_KEY, value ? '1' : '0');
  window.dispatchEvent(new Event(COLLAPSE_CHANGE_EVENT));
}

export function Sidebar({
  groups,
  adminDisplayName,
}: {
  groups: NavGroup[];
  adminDisplayName: string;
}) {
  const pathname = usePathname();
  const isCollapsed = useCollapsed();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [manuallyExpandedGroups, setManuallyExpandedGroups] = useState<Set<string>>(new Set());
  const [manuallyCollapsedGroups, setManuallyCollapsedGroups] = useState<Set<string>>(new Set());

  function toggleGroup(href: string, currentlyExpanded: boolean) {
    if (currentlyExpanded) {
      setManuallyCollapsedGroups((prev) => new Set(prev).add(href));
      setManuallyExpandedGroups((prev) => {
        const next = new Set(prev);
        next.delete(href);
        return next;
      });
    } else {
      setManuallyExpandedGroups((prev) => new Set(prev).add(href));
      setManuallyCollapsedGroups((prev) => {
        const next = new Set(prev);
        next.delete(href);
        return next;
      });
    }
  }

  return (
    <>
      {/* Mobile top bar — only below md; the desktop rail is always
          visible so it doesn't need an equivalent open/close affordance. */}
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 md:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="text-[var(--foreground)]"
        >
          <Menu size={22} />
        </button>
        <span className="text-sm font-medium text-[var(--foreground)]">InvolveMe Admin</span>
        <ThemeToggle />
      </div>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Fixed + translate-based drawer below md (collapse doesn't apply
          on mobile — the drawer is an overlay, not a permanent rail, so it
          always shows full width+labels while open). At md and up it
          rejoins normal flex flow (sticky, not fixed) so its width
          (collapsed vs expanded) pushes <main> over via ordinary flexbox,
          no manual margin-syncing between two separately-rendered pieces
          needed. */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-transform duration-200 md:sticky md:top-0 md:h-screen md:shrink-0 md:translate-x-0 ${
          isCollapsed ? 'md:w-16' : 'md:w-64'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-3">
          {!isCollapsed && (
            <span className="truncate text-sm font-semibold text-[var(--foreground)]">
              InvolveMe Admin
            </span>
          )}
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="text-[var(--foreground)]/60 hover:text-[var(--foreground)] md:hidden"
          >
            <X size={20} />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(!isCollapsed)}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden text-[var(--foreground)]/60 hover:text-[var(--foreground)] md:block"
          >
            {isCollapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {groups.map((group) => {
            const Icon = NAV_ICON_MAP[group.icon];
            const hasActiveChild = group.children?.some(
              (c) => pathname === c.href || pathname.startsWith(c.href + '/'),
            );
            const isActive =
              pathname === group.href || (!group.children && pathname.startsWith(group.href + '/'));
            // Auto-expanded when a child route is active, unless the admin
            // explicitly collapsed it this session; otherwise collapsed by
            // default, unless explicitly expanded this session.
            const isExpanded =
              !isCollapsed &&
              !!group.children &&
              (manuallyExpandedGroups.has(group.href) ||
                (!!hasActiveChild && !manuallyCollapsedGroups.has(group.href)));

            return (
              <div key={group.href} className="mb-1">
                <div className="flex items-center">
                  <Link
                    href={group.href}
                    title={isCollapsed ? group.label : undefined}
                    className={`flex flex-1 items-center gap-3 rounded px-2 py-2 text-sm ${
                      isActive || hasActiveChild
                        ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                        : 'text-[var(--foreground)]/70 hover:bg-[var(--surface-alt)] hover:text-[var(--foreground)]'
                    }`}
                  >
                    <Icon size={18} className="shrink-0" />
                    {!isCollapsed && <span className="truncate">{group.label}</span>}
                  </Link>
                  {!isCollapsed && group.children && (
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.href, isExpanded)}
                      aria-label={isExpanded ? `Collapse ${group.label}` : `Expand ${group.label}`}
                      className="px-1.5 text-[var(--foreground)]/50 hover:text-[var(--foreground)]"
                    >
                      <ChevronDown
                        size={14}
                        className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      />
                    </button>
                  )}
                </div>

                {!isCollapsed && group.children && isExpanded && (
                  <div className="ml-6 mt-0.5 flex flex-col gap-0.5 border-l border-[var(--border)] pl-3">
                    {group.children.map((child) => {
                      const childActive = pathname === child.href;
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={`rounded px-2 py-1.5 text-xs ${
                            childActive
                              ? 'font-medium text-[var(--foreground-accent)]'
                              : 'text-[var(--foreground)]/60 hover:text-[var(--foreground)]'
                          }`}
                        >
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="border-t border-[var(--border)] p-3">
          {!isCollapsed && (
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="truncate text-xs text-[var(--foreground)]/60">
                {adminDisplayName}
              </span>
              <ThemeToggle />
            </div>
          )}
          <form action={logoutAction}>
            <button
              type="submit"
              title={isCollapsed ? 'Sign out' : undefined}
              className="w-full rounded px-2 py-1.5 text-left text-xs text-[var(--foreground)]/60 hover:bg-[var(--surface-alt)] hover:text-[var(--foreground)]"
            >
              {isCollapsed ? '⏻' : 'Sign out'}
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
