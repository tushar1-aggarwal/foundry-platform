/**
 * Self-service API key management section, dropped into SettingsView.
 *
 * Lists the caller's own live keys, with a "Create new key" affordance
 * that opens CreateKeyDialog. Per-row revoke uses an inline confirm
 * (revoke is irreversible -- breaks any running script using the key,
 * which is more dangerous than logout's "just sign in again").
 *
 * Falls back to a quiet message when the caller is anonymous / local-mode
 * / api-key authenticated, since the server `apikey/list` would FORBID
 * those callers anyway. Better UX than rendering an empty list with a
 * "Create" button that fails on submit.
 */
import { useEffect, useState } from "react";
import { Card } from "../../components/ui/card.js";
import { Button } from "../../components/ui/button.js";
import { useTransport } from "../../transport/TransportContext.js";
import { useAuth } from "../../auth/AuthContext.js";
import { listApiKeys, revokeApiKey, type ApiKeyRow } from "./api-key-rpc.js";
import { CreateKeyDialog } from "./CreateKeyDialog.js";

function relative(from: string | null): string {
  if (!from) return "-";
  const d = Date.parse(from);
  if (!Number.isFinite(d)) return from;
  const diffMs = Date.now() - d;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function ApiKeysSection() {
  const transport = useTransport();
  const { identity } = useAuth();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  // Soft-gate: if we don't have a logged-in identity, skip the RPC --
  // it would FORBID anyway and the resulting error message is noisy.
  const supported = identity !== null && identity.userId !== "local" && !identity.userId.startsWith("ak-");

  const refresh = async () => {
    if (!supported) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await listApiKeys(transport);
      setKeys(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  const handleRevoke = async (id: string) => {
    setRevoking(id);
    setError(null);
    try {
      await revokeApiKey(transport, id);
      setKeys((ks) => ks.filter((k) => k.id !== id));
      setConfirmingRevoke(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke key");
    } finally {
      setRevoking(null);
    }
  };

  if (!supported) {
    return (
      <section className="mb-8">
        <h2 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] mb-3">API Keys</h2>
        <Card className="p-4 text-[13px] text-muted-foreground">
          Sign in with Google to manage your API keys here. (Local-mode and API-key sessions don&apos;t have a
          self-service surface; use the CLI&apos;s <code>ark auth</code> commands instead.)
        </Card>
      </section>
    );
  }

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">API Keys</h2>
        <Button type="button" onClick={() => setShowCreate(true)} disabled={loading}>
          + New key
        </Button>
      </div>

      {error && <Card className="p-3 mb-3 text-[13px] text-destructive border-destructive/40">{error}</Card>}

      {loading ? (
        <Card className="p-4 text-[13px] text-muted-foreground">Loading…</Card>
      ) : keys.length === 0 ? (
        <Card className="p-4 text-[13px] text-muted-foreground">
          No API keys yet. Click <strong>+ New key</strong> to mint one for CLI / programmatic use.
        </Card>
      ) : (
        <Card className="divide-y divide-[var(--border)]">
          {keys.map((k) => (
            <div key={k.id} className="p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-foreground truncate">{k.name}</span>
                  <span className="text-[10px] uppercase tracking-[0.04em] text-muted-foreground bg-[var(--bg-hover)] px-1.5 py-[1px] rounded">
                    {k.role}
                  </span>
                </div>
                <div className="text-[11px] text-muted-foreground font-[family-name:var(--font-mono-ui)] mt-0.5">
                  {k.id} · created {relative(k.createdAt)} · used {relative(k.lastUsedAt)}
                  {k.expiresAt && ` · expires ${relative(k.expiresAt)}`}
                </div>
              </div>
              {confirmingRevoke === k.id ? (
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="text-muted-foreground">Revoke {k.name}?</span>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setConfirmingRevoke(null)}
                    disabled={revoking === k.id}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => void handleRevoke(k.id)}
                    disabled={revoking === k.id}
                  >
                    {revoking === k.id ? "Revoking..." : "Revoke"}
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="ghost" onClick={() => setConfirmingRevoke(k.id)}>
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}

      {showCreate && (
        <CreateKeyDialog
          callerRole={identity!.role}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </section>
  );
}
