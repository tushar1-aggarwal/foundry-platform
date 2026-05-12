import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button.js";
import { ConfirmDialog } from "../ui/ConfirmDialog.js";
import { useAdminApi } from "./adminApi.js";
import type { MembershipRole, TenantSearchUser } from "./types.js";

const ROLES: MembershipRole[] = ["owner", "admin", "member", "viewer"];
const MIN_SEARCH_LEN = 3;
const DEBOUNCE_MS = 250;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MemberPickerProps {
  /** Team the picker is anchored to. The server resolves this to tenant. */
  teamId: string;
  /** Called after a successful add/role-change so the parent can refresh. */
  onAdded: () => void;
  onToast?: (msg: string, type: string) => void;
}

/**
 * Add-member combobox for the TeamsTab.
 *
 * Type ≥3 chars to trigger a debounced (250ms) tenant-scoped autocomplete
 * via `admin/team/members/search`. Each result row shows email + name and
 * a tag if the user already belongs to this team. The action button flips
 * based on what's selected and the role-dropdown value:
 *
 *   - Picked existing user, same role as current   -> disabled
 *   - Picked existing user, different role         -> "Update role" (confirm)
 *   - Picked existing user, not in this team yet   -> "Add"
 *   - No match in list but typed string is a valid email -> "Add" (new user)
 *   - Otherwise                                    -> disabled
 *
 * Race-safety: monotonic request token discards stale responses (same
 * pattern as `ScopingTab.refresh`). The picker dropdown closes on outside
 * mouse-down and on Escape.
 */
export function MemberPicker({ teamId, onAdded, onToast }: MemberPickerProps) {
  const adminApi = useAdminApi();

  // ARIA 1.2 requires the combobox input to point at its popup via
  // aria-controls. Anchor the listbox id to the team -- the picker
  // remounts when teamId changes anyway, so the id stays stable for
  // the lifetime of a given picker instance.
  const listboxId = `member-picker-listbox-${teamId}`;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TenantSearchUser[]>([]);
  const [picked, setPicked] = useState<TenantSearchUser | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<MembershipRole>("member");
  const [confirming, setConfirming] = useState<{ fromRole: MembershipRole; toRole: MembershipRole } | null>(null);
  const [busy, setBusy] = useState(false);

  // Race guard for concurrent debounced searches. Each kicked-off search
  // captures the current token; only the latest commits its result.
  const reqRef = useRef(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown on outside click. Capture phase + mousedown so the
  // close happens before any click inside an upstream handler.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  // Reset state when the parent swaps to a different team. Without this,
  // a picked user from team-A would stay selected after the admin clicks
  // team-B in the left list.
  useEffect(() => {
    setQuery("");
    setResults([]);
    setPicked(null);
    setOpen(false);
    setRole("member");
  }, [teamId]);

  // Debounced search.
  useEffect(() => {
    const trimmed = query.trim();
    // A picked row already corresponds to a server result -- no need to
    // re-fetch while the input still matches it.
    if (picked && trimmed === picked.email) return;
    if (trimmed.length < MIN_SEARCH_LEN) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myToken = ++reqRef.current;
    const handle = setTimeout(async () => {
      try {
        const rows = await adminApi.searchTeamCandidates(teamId, trimmed);
        if (myToken !== reqRef.current) return; // stale
        setResults(rows);
        setOpen(true);
      } catch (e: any) {
        if (myToken !== reqRef.current) return;
        onToast?.(`Search failed: ${e?.message ?? e}`, "error");
        setResults([]);
      } finally {
        if (myToken === reqRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, teamId, picked, adminApi, onToast]);

  const looksLikeNewEmail = useMemo(() => {
    const trimmed = query.trim();
    if (!EMAIL_RE.test(trimmed)) return false;
    if (picked) return false;
    return !results.some((r) => r.email.toLowerCase() === trimmed.toLowerCase());
  }, [query, picked, results]);

  type ButtonMode = "add" | "update" | "disabled-same-role" | "disabled-empty";
  const buttonMode: ButtonMode = useMemo(() => {
    if (picked) {
      if (picked.existing_role === null) return "add";
      if (picked.existing_role === role) return "disabled-same-role";
      return "update";
    }
    if (looksLikeNewEmail) return "add";
    return "disabled-empty";
  }, [picked, role, looksLikeNewEmail]);

  const reset = useCallback(() => {
    setQuery("");
    setResults([]);
    setPicked(null);
    setOpen(false);
    setRole("member");
  }, []);

  const doAdd = useCallback(async () => {
    // Pass the email AS-IS. The picker's free-text path is the only
    // place users.upsertByEmail meets new input; if we lowercased
    // here, a pre-existing user `Foo@Example.com` would split into a
    // second `foo@example.com` row because SQLite's live-row unique
    // index is BINARY-collated. Let the server own canonicalisation
    // (or its absence) -- the picker is just a transport.
    const email = picked?.email ?? query.trim();
    setBusy(true);
    try {
      await adminApi.addMember(teamId, email, role);
      onToast?.(`Added ${email} as ${role}`, "success");
      reset();
      onAdded();
    } catch (e: any) {
      onToast?.(`Failed: ${e?.message ?? e}`, "error");
    } finally {
      setBusy(false);
    }
  }, [picked, query, role, teamId, adminApi, onToast, onAdded, reset]);

  function handleClickButton() {
    if (buttonMode === "add") {
      void doAdd();
      return;
    }
    if (buttonMode === "update" && picked) {
      setConfirming({ fromRole: picked.existing_role as MembershipRole, toRole: role });
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex gap-2 mb-3">
        <div className="flex-1 relative">
          <input
            aria-label="Find user by email or name"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls={listboxId}
            className="w-full h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
            placeholder="Type ≥3 chars of email or name..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // Typing always invalidates the picked row -- the user is
              // either editing a typo or starting a new search.
              if (picked) setPicked(null);
              if (!open) setOpen(true);
            }}
            onFocus={() => {
              if (results.length > 0 || query.trim().length >= MIN_SEARCH_LEN) setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                e.preventDefault();
              }
            }}
          />
          {open && (
            <div
              id={listboxId}
              role="listbox"
              className="absolute left-0 right-0 top-full mt-1 z-20 max-h-64 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg)] shadow-lg"
            >
              {loading && <div className="p-2 text-[12px] text-[var(--fg-muted)]">Searching...</div>}
              {!loading && query.trim().length < MIN_SEARCH_LEN && (
                <div className="p-2 text-[12px] text-[var(--fg-muted)]">Type at least 3 characters to search.</div>
              )}
              {!loading && query.trim().length >= MIN_SEARCH_LEN && results.length === 0 && !looksLikeNewEmail && (
                <div className="p-2 text-[12px] text-[var(--fg-muted)]">No matching users in this tenant.</div>
              )}
              {results.map((r) => {
                const isPicked = picked?.id === r.id;
                // Build a "status tag" for each row -- only one tag is
                // shown, with priority: already-in-this-team > orphan >
                // also-in-other-teams. The admin only needs the most
                // load-bearing signal at a glance.
                let tag: { label: string; title?: string } | null = null;
                if (r.existing_role) {
                  tag = { label: `already ${r.existing_role}` };
                } else if (r.orphan) {
                  tag = {
                    label: "no memberships",
                    title: "This user has no memberships anywhere and cannot log in until added to a team.",
                  };
                } else if (r.other_memberships.length > 0) {
                  const summary = r.other_memberships.map((om) => `${om.team_name} (${om.role})`).join(", ");
                  tag = { label: `also in: ${summary}`, title: summary };
                }
                return (
                  <button
                    key={r.id}
                    type="button"
                    role="option"
                    aria-selected={isPicked}
                    onClick={() => {
                      setPicked(r);
                      setQuery(r.email);
                      // Pre-fill the role dropdown with the user's current
                      // role in this team (if any) so "Update role" only
                      // surfaces when the admin actually changes it.
                      if (r.existing_role) setRole(r.existing_role);
                      setOpen(false);
                    }}
                    className={
                      "w-full text-left px-2 py-1.5 text-sm hover:bg-[var(--bg-subtle)] flex items-center justify-between gap-2" +
                      (isPicked ? " bg-[var(--bg-subtle)]" : "")
                    }
                  >
                    <span className="truncate">
                      <span className="font-medium">{r.email}</span>
                      {r.name && <span className="ml-2 text-[var(--fg-muted)]">{r.name}</span>}
                    </span>
                    {tag && (
                      <span
                        title={tag.title}
                        className="shrink-0 rounded border border-[var(--border)] bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--fg-muted)]"
                      >
                        {tag.label}
                      </span>
                    )}
                  </button>
                );
              })}
              {looksLikeNewEmail && (
                <button
                  type="button"
                  role="option"
                  onClick={() => {
                    // Free-text path: server's addMember upserts a user
                    // row from this email. No `picked` set -- buttonMode
                    // stays "add" via looksLikeNewEmail.
                    setOpen(false);
                  }}
                  className="w-full text-left px-2 py-1.5 text-sm hover:bg-[var(--bg-subtle)] border-t border-[var(--border)] text-[var(--fg-muted)]"
                >
                  + Add new user: <span className="font-mono">{query.trim()}</span>
                </button>
              )}
            </div>
          )}
        </div>
        <select
          aria-label="Role"
          className="h-8 px-2 text-sm rounded border border-[var(--border)] bg-[var(--bg)]"
          value={role}
          onChange={(e) => setRole(e.target.value as MembershipRole)}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={handleClickButton}
          disabled={busy || buttonMode === "disabled-same-role" || buttonMode === "disabled-empty"}
          title={
            buttonMode === "disabled-same-role"
              ? `Already a member with role '${role}'`
              : buttonMode === "disabled-empty"
                ? "Pick a user or type a new email"
                : undefined
          }
        >
          {buttonMode === "update" ? "Update role" : "Add"}
        </Button>
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={async () => {
          await doAdd();
          setConfirming(null);
        }}
        title="Change member role?"
        message={
          confirming
            ? `Change ${picked?.email}'s role from '${confirming.fromRole}' to '${confirming.toRole}' in this team?`
            : ""
        }
        confirmLabel="Update role"
        loading={busy}
      />
    </div>
  );
}
