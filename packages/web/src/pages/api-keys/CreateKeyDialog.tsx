/**
 * Form modal for minting a new API key.
 *
 * Two-step flow:
 *   1. Form: name (required), role (capped at caller's own role),
 *      optional expiration. Submit → `apikey/create` RPC.
 *   2. On success, swap to RevealedKeyDialog with the plaintext. The
 *      caller's `onCreated` runs after the user dismisses the reveal,
 *      so the parent list refreshes once and the user sees the new
 *      row added.
 *
 * Cancel from the form is fine (Esc / outside-click handled by the
 * parent or the Cancel button). NOT fine on the RevealedKeyDialog --
 * see its own contract.
 */
import { useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { useTransport } from "../../transport/TransportContext.js";
import { createApiKey, type CreateApiKeyResult } from "./api-key-rpc.js";
import { RevealedKeyDialog } from "./RevealedKeyDialog.js";

type Role = "admin" | "member" | "viewer";
type ExpiryChoice = "never" | "30d" | "90d" | "1y";

interface CreateKeyDialogProps {
  /** Caller's own role -- caps the role-dropdown options. */
  callerRole: Role | "worker";
  /** Called after RevealedKeyDialog is dismissed so the list can refresh. */
  onCreated: () => void;
  /** Cancel from the form. */
  onCancel: () => void;
}

const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3 };

function rolesAvailable(callerRole: Role | "worker"): Role[] {
  const roles: Role[] = ["viewer", "member", "admin"];
  // worker users shouldn't reach this dialog at all (the page itself
  // gates on being logged in) but be defensive: cap at member if
  // somehow we got here.
  const rank = callerRole === "worker" ? 0 : ROLE_RANK[callerRole];
  return roles.filter((r) => ROLE_RANK[r] <= rank);
}

function expiryToIso(choice: ExpiryChoice): string | undefined {
  if (choice === "never") return undefined;
  const days = choice === "30d" ? 30 : choice === "90d" ? 90 : 365;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function CreateKeyDialog({ callerRole, onCreated, onCancel }: CreateKeyDialogProps) {
  const transport = useTransport();
  const available = rolesAvailable(callerRole);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(available.includes("member") ? "member" : (available[0] ?? "viewer"));
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateApiKeyResult | null>(null);

  if (created) {
    return (
      <RevealedKeyDialog
        plaintext={created.key}
        keyId={created.id}
        onDismiss={() => {
          setCreated(null);
          onCreated();
        }}
      />
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await createApiKey(transport, {
        name: name.trim(),
        role,
        expires: expiryToIso(expiry),
      });
      setCreated(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create key");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-key-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        // Outside click cancels (form is throwaway, no plaintext to protect yet).
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl max-w-md w-full mx-4 p-6"
      >
        <h2 id="create-key-title" className="text-lg font-semibold mb-4 text-[var(--fg)]">
          Create API key
        </h2>

        <label className="block text-sm font-medium text-[var(--fg)] mb-1" htmlFor="create-key-name">
          Name
        </label>
        <Input
          id="create-key-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. ci-deploy, my-laptop"
          autoFocus
          disabled={submitting}
        />

        <label className="block text-sm font-medium text-[var(--fg)] mt-4 mb-1" htmlFor="create-key-role">
          Role
        </label>
        <select
          id="create-key-role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          disabled={submitting}
          className="w-full bg-[var(--bg)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--fg)]"
        >
          {available.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <label className="block text-sm font-medium text-[var(--fg)] mt-4 mb-1" htmlFor="create-key-expiry">
          Expires
        </label>
        <select
          id="create-key-expiry"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}
          disabled={submitting}
          className="w-full bg-[var(--bg)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--fg)]"
        >
          <option value="never">Never</option>
          <option value="30d">30 days</option>
          <option value="90d">90 days</option>
          <option value="1y">1 year</option>
        </select>

        {error && <p className="text-sm text-destructive mt-3">{error}</p>}

        <div className="flex gap-2 mt-5">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !name.trim()} className="flex-1">
            {submitting ? "Creating..." : "Create key"}
          </Button>
        </div>
      </form>
    </div>
  );
}
