/**
 * Wire-typed shape for a scoping-override row, returned by the
 * `admin/scoping/*` RPC surface. Kept here as its own type module
 * because the web admin layer imports it by this path; the RPC
 * methods themselves live on `ArkClient` (`../client.ts`).
 */

export interface ScopingOverrideRow {
  id: string;
  scope_kind: "user" | "team" | "tenant";
  scope_id: string;
  key: string;
  value_json: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  set_by: string | null;
  deleted_by: string | null;
}
