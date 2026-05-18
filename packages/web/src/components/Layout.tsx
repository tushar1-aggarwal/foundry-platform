import { useEffect, useMemo } from "react";
import { IconRail } from "./ui/IconRail.js";
import type { IconRailItem } from "./ui/IconRail.js";
import { Play, Bot, Zap, Monitor, Clock, DollarSign, Cog, Wrench, Calendar, Plug, Shield, Key } from "lucide-react";
import { useOptionalAuth } from "../auth/AuthContext.js";
import type { Identity } from "../auth/whoami.js";
import { UserMenu } from "./UserMenu.js";

interface LayoutProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  /** Middle column -- persistent 400px session list (or other context list). */
  list?: React.ReactNode;
  /** Main pane. */
  children: React.ReactNode;
  /** Total unread message count to badge on Sessions icon. */
  totalUnread?: number;
  /** Current user avatar initials. */
  avatarInitials?: string;
  /** Foot text (daemon latency etc.). */
  latencyText?: string;
}

const BASE_NAV_ITEMS: IconRailItem[] = [
  { id: "sessions", icon: <Play size={18} strokeWidth={1.5} />, label: "Sessions", shortcut: "S" },
  { id: "agents", icon: <Bot size={18} strokeWidth={1.5} />, label: "Agents", shortcut: "A" },
  { id: "flows", icon: <Zap size={18} strokeWidth={1.5} />, label: "Flows", shortcut: "F" },
  { id: "compute", icon: <Monitor size={18} strokeWidth={1.5} />, label: "Compute", shortcut: "C" },
  { id: "history", icon: <Clock size={18} strokeWidth={1.5} />, label: "History", shortcut: "H" },
  { id: "tools", icon: <Wrench size={18} strokeWidth={1.5} />, label: "Tools", shortcut: "T" },
  { id: "schedules", icon: <Calendar size={18} strokeWidth={1.5} />, label: "Schedules" },
  { id: "integrations", icon: <Plug size={18} strokeWidth={1.5} />, label: "Integrations", shortcut: "I" },
  { id: "secrets", icon: <Key size={18} strokeWidth={1.5} />, label: "Secrets" },
  { id: "costs", icon: <DollarSign size={18} strokeWidth={1.5} />, label: "Costs", shortcut: "$" },
];

const ADMIN_NAV_ITEM: IconRailItem = {
  id: "admin",
  icon: <Shield size={18} strokeWidth={1.5} />,
  label: "Admin",
};

/**
 * Compose the icon-rail nav items. Pure function -- exported so tests can
 * exercise the role gating + unread-badge merging without rendering the
 * whole `Layout` tree.
 *
 * - `totalUnread > 0` puts a numeric badge on the Sessions entry.
 * - `role === "admin"` appends the Admin entry at the end of the rail.
 *   Member / viewer / null (anonymous) callers don't see it -- the page
 *   itself also rejects them with FORBIDDEN, so showing the entry would
 *   be a dead end.
 *
 * Signature takes `role` directly (not the full `Identity`) so the
 * `useMemo` in `Layout` can key off a stable primitive instead of the
 * `whoami`-returned identity object, which churns on every refresh.
 */
export function buildNavItems(role: Identity["role"] | null, totalUnread: number | undefined): IconRailItem[] {
  const items: IconRailItem[] = totalUnread
    ? BASE_NAV_ITEMS.map((item) => (item.id === "sessions" ? { ...item, badge: totalUnread } : item))
    : [...BASE_NAV_ITEMS];
  if (role === "admin") items.push(ADMIN_NAV_ITEM);
  return items;
}

const SETTINGS_ITEM: IconRailItem = {
  id: "settings",
  icon: <Cog size={18} strokeWidth={1.5} />,
  label: "Settings",
  shortcut: ",",
};

const SHORTCUTS: Record<string, string> = {
  s: "sessions",
  a: "agents",
  f: "flows",
  c: "compute",
  h: "history",
  t: "tools",
  i: "integrations",
  $: "costs",
  ",": "settings",
};

/**
 * Layout -- 3-column chrome from `/tmp/ark-design-system/preview/chrome-sidebar.html`.
 *
 *   grid-template-columns: 60px 400px 1fr
 *
 * The 60px icon rail is always mounted. The 400px middle column (session list
 * or other context panel) is mounted when `list` is non-null; callers that
 * don't need a context column (e.g. Settings, Admin) can omit it and the grid
 * collapses to `60px 1fr`.
 */
export function Layout({ view, onNavigate, list, children, totalUnread, avatarInitials, latencyText }: LayoutProps) {
  // Phase 1: when an authenticated identity is present, render the
  // UserMenu (avatar + popover with email/role/logout) in the IconRail
  // bottom slot. Layout is also rendered by unit tests outside the
  // App tree, so we use the optional variant -- a missing AuthProvider
  // simply means no UserMenu (the IconRail's `avatarInitials` fallback
  // path still works for those tests).
  const auth = useOptionalAuth();
  const identity = auth?.identity ?? null;
  const role = identity?.role ?? null;
  // Re-derive only when the visible state for the rail actually changes
  // (badge count + admin gate). Keying off `role` (a stable primitive)
  // avoids churning on every whoami refresh that doesn't move the role.
  const navItems = useMemo(() => buildNavItems(role, totalUnread), [role, totalUnread]);

  // Keyboard shortcuts for navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;
      const el = target ?? active;
      if (el) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
        if (el.isContentEditable) return;
        const role = el.getAttribute?.("role");
        if (role === "textbox" || role === "combobox" || role === "searchbox") return;
      }

      const key = e.key.toLowerCase();
      const dest = SHORTCUTS[key] || SHORTCUTS[e.key];
      if (dest) {
        e.preventDefault();
        onNavigate(dest);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onNavigate]);

  return (
    <div
      className="h-screen bg-[var(--bg)] overflow-hidden"
      style={{
        display: "grid",
        gridTemplateColumns: list ? "60px 400px 1fr" : "60px 1fr",
      }}
    >
      <IconRail
        items={navItems}
        activeId={view}
        onSelect={onNavigate}
        settingsItem={SETTINGS_ITEM}
        avatarInitials={avatarInitials}
        avatarSlot={identity ? <UserMenu identity={identity} /> : undefined}
        latencyText={latencyText}
      />
      {list && (
        <aside
          className="h-full min-w-0 overflow-hidden flex flex-col border-r border-[var(--border)] bg-[var(--bg)]"
          aria-label="Session list"
        >
          {list}
        </aside>
      )}
      <main id="main" className="h-full min-w-0 overflow-hidden flex flex-col">
        {children}
      </main>
    </div>
  );
}
