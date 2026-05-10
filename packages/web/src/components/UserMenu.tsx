/**
 * Phase 1 user menu -- avatar + popover with identity + logout.
 *
 * Sits in the IconRail's bottom slot (`avatarSlot` prop). Click the
 * avatar to toggle a small popover that shows the signed-in user's
 * email, tenant, and role, plus a one-click "Sign out" item.
 *
 * Logout flow: POST /auth/logout with `credentials: "include"` so the
 * session cookie rides. The server's Origin allowlist is satisfied
 * automatically because the browser auto-attaches Origin on POST. On
 * 200, dispatch `ark:auth-required` so AuthContext drops to anonymous
 * and the app re-renders LoginPage.
 *
 * No confirm dialog (per PR plan): re-signing in is one click, so a
 * dialog is friction without value.
 */
import { useEffect, useRef, useState } from "react";
import type { Identity } from "../auth/whoami.js";

interface UserMenuProps {
  identity: Identity;
}

function initialsFromEmail(email: string | null): string {
  if (!email) return "?";
  const local = email.split("@")[0] ?? "";
  if (!local) return "?";
  // first letter of local-part + first letter after first separator (./-/_)
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

async function callLogout(): Promise<{ ok: boolean; status: number }> {
  // The conductor enforces an Origin allowlist on this route. The
  // browser auto-attaches Origin so this just works for same-origin
  // and dev-proxy paths; production deployments populate
  // `auth.session.allowedOrigins` so the deployment's web host hits
  // the allowlist.
  //
  // We propagate the response status to the caller so a non-2xx (e.g.
  // 401 from a missing/mismatched Origin) is visible in the console
  // rather than silently leaving the server-side session row alive.
  // Phantom logout: the UI used to swallow a 401 here, so the user
  // appeared signed-out client-side while the cookie + DB row stayed
  // valid -- a new tab still authed. The handler logs and at minimum
  // tries a hard reload as the recovery path.
  const res = await fetch("/auth/logout", {
    method: "POST",
    credentials: "include",
  });
  return { ok: res.ok, status: res.status };
}

export function UserMenu({ identity }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on outside click + Esc.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initials = initialsFromEmail(identity.email);
  const tooltipText = identity.email
    ? `${identity.email} (${identity.tenantId} / ${identity.role})`
    : `${identity.userId} (${identity.tenantId} / ${identity.role})`;

  const handleLogout = async () => {
    setOpen(false);
    let serverDeletedSession = false;
    try {
      const { ok, status } = await callLogout();
      serverDeletedSession = ok;
      if (!ok) {
        // Most likely cause: Origin allowlist misconfig on the deployment.
        // Without this the SAME cookie keeps working in any other tab --
        // phantom-logout. Surface it so an operator or developer notices.
        console.error(`[ark] /auth/logout returned ${status}; cookie may still be active server-side`);
      }
    } catch (err) {
      console.error(`[ark] /auth/logout request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    window.dispatchEvent(new CustomEvent("ark:auth-required"));
    // If the server didn't actually delete the session row, a hard reload
    // is the only thing that bounces the cookie out of the active page
    // process tree. Anonymous-state UI alone wouldn't help because the
    // (still valid) cookie would auto-reauthorize the next RPC.
    if (!serverDeletedSession) {
      try {
        window.location.replace("/");
      } catch {
        /* SSR / sandboxed -- skipping reload, custom-event already fired */
      }
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Signed in as ${identity.email ?? identity.userId}. Open user menu.`}
        title={tooltipText}
        className="relative w-[32px] h-[32px] mt-[2px] rounded-full grid place-items-center border-[2px] border-[var(--bg-sidebar)] text-white font-semibold text-[12px] font-[family-name:var(--font-mono-ui)] cursor-pointer"
        style={{ backgroundImage: "linear-gradient(135deg, #f59e0b, #ec4899)" }}
      >
        {initials}
        <span
          aria-hidden
          className="absolute -bottom-[1px] -right-[1px] w-[9px] h-[9px] rounded-full bg-[var(--completed)] shadow-[0_0_0_2px_var(--bg-sidebar),0_0_4px_rgba(52,211,153,0.6)]"
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-[calc(100%+10px)] bottom-0 z-50 min-w-[220px] rounded-md border border-[var(--border)] bg-[#26263c] shadow-[0_4px_12px_rgba(0,0,0,0.5)] p-3"
        >
          <div className="text-xs text-[var(--fg-muted)] mb-1">Signed in as</div>
          <div className="text-sm text-[var(--fg)] font-medium truncate" title={identity.email ?? identity.userId}>
            {identity.email ?? identity.userId}
          </div>
          <div className="text-[11px] text-[var(--fg-muted)] mt-1 font-[family-name:var(--font-mono-ui)]">
            {identity.tenantId} · {identity.role}
          </div>
          <div className="border-t border-[var(--border)] my-3" />
          <button
            type="button"
            role="menuitem"
            onClick={handleLogout}
            className="w-full text-left px-2 py-1.5 rounded text-sm text-[var(--fg)] hover:bg-[var(--bg-hover)] cursor-pointer"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
