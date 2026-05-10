/**
 * Self-service API key RPC client wrappers.
 *
 * Mirror of the conductor's `apikey/*` handler module. Keeps the dialog
 * components free of inline `transport.rpc(...)` calls so the surface
 * stays easy to swap in tests.
 *
 * The wrapper does NOT swallow errors -- the caller dialog needs the
 * thrown message to render an inline form error. Compare with
 * `auth/whoami.ts` which DOES swallow because its caller treats failure
 * as "anonymous".
 */
import type { WebTransport } from "../../transport/types.js";

export interface ApiKeyRow {
  id: string;
  tenantId: string;
  name: string;
  role: "admin" | "member" | "viewer" | "worker";
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface CreateApiKeyInput {
  name: string;
  /** Defaults to caller's own role on the server side. */
  role?: "admin" | "member" | "viewer";
  /** ISO 8601 expiration. Optional. */
  expires?: string;
}

export interface CreateApiKeyResult {
  id: string;
  /** Plaintext key. Only returned at create time; never persisted client-side. */
  key: string;
}

export async function listApiKeys(transport: WebTransport): Promise<ApiKeyRow[]> {
  const res = await transport.rpc<{ keys: ApiKeyRow[] }>("apikey/list");
  return res?.keys ?? [];
}

export async function createApiKey(transport: WebTransport, input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  return transport.rpc<CreateApiKeyResult>("apikey/create", input as unknown as Record<string, unknown>);
}

export async function revokeApiKey(transport: WebTransport, id: string): Promise<void> {
  await transport.rpc<{ ok: true }>("apikey/revoke", { id });
}
