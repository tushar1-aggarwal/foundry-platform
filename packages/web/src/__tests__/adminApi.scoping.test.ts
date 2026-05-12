/**
 * `adminApi` scoping-wrapper tests.
 *
 * Pin the wire contract between the dashboard and the `admin/scoping/*`
 * JSON-RPC surface added in PR #564: method names, parameter shapes,
 * and response-envelope unwrapping. Doesn't exercise the server side --
 * that's covered by `admin-scoping.test.ts` in the conductor package.
 *
 * MockTransport.calls records every rpc() invocation as
 * `{ method, params }`, which is the most direct way to assert "did the
 * wrapper dispatch the right thing?" without needing React or a real
 * daemon.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { MockTransport } from "../transport/MockTransport.js";
import { makeAdminApi } from "../components/admin/adminApi.js";
import type { ScopingOverrideRow } from "../components/admin/types.js";

function row(overrides: Partial<ScopingOverrideRow> = {}): ScopingOverrideRow {
  return {
    id: "s-1",
    scope_kind: "tenant",
    scope_id: "default",
    key: "runtime",
    value_json: JSON.stringify("codex"),
    tenant_id: "default",
    created_at: "2026-05-11T00:00:00Z",
    updated_at: "2026-05-11T00:00:00Z",
    deleted_at: null,
    set_by: "u-rachna",
    deleted_by: null,
    ...overrides,
  };
}

let transport: MockTransport;
let admin: ReturnType<typeof makeAdminApi>;

beforeEach(() => {
  transport = new MockTransport();
  admin = makeAdminApi(transport);
});

describe("adminApi.scopingListPage", () => {
  test("dispatches admin/scoping/list with empty filters when none given", async () => {
    transport.register("admin/scoping/list", () => ({ rows: [], truncated: false }));
    const result = await admin.scopingListPage();
    expect(transport.calls).toEqual([{ method: "admin/scoping/list", params: {} }]);
    expect(result).toEqual({ rows: [], truncated: false });
  });

  test("forwards every filter field verbatim", async () => {
    transport.register("admin/scoping/list", () => ({ rows: [row()], truncated: false }));
    await admin.scopingListPage({
      scope_kind: "user",
      scope_id: "u-1",
      key: "runtime",
      includeDeleted: true,
    });
    expect(transport.calls[0].params).toEqual({
      scope_kind: "user",
      scope_id: "u-1",
      key: "runtime",
      includeDeleted: true,
    });
  });

  test("surfaces truncated flag from the server", async () => {
    transport.register("admin/scoping/list", () => ({ rows: [row(), row({ id: "s-2" })], truncated: true }));
    const result = await admin.scopingListPage();
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBe(2);
  });
});

describe("adminApi.scopingGet", () => {
  test("dispatches admin/scoping/get with id and unwraps the row envelope", async () => {
    transport.register("admin/scoping/get", () => ({ row: row({ id: "s-99" }) }));
    const r = await admin.scopingGet("s-99");
    expect(transport.calls).toEqual([{ method: "admin/scoping/get", params: { id: "s-99" } }]);
    expect(r.id).toBe("s-99");
  });
});

describe("adminApi.scopingSet", () => {
  test("dispatches admin/scoping/set with the full payload and unwraps the row", async () => {
    transport.register("admin/scoping/set", () => ({ row: row({ value_json: JSON.stringify("claude-code") }) }));
    const r = await admin.scopingSet({
      scope_kind: "user",
      scope_id: "u-1",
      key: "runtime",
      value: "claude-code",
    });
    expect(transport.calls[0].method).toBe("admin/scoping/set");
    expect(transport.calls[0].params).toEqual({
      scope_kind: "user",
      scope_id: "u-1",
      key: "runtime",
      value: "claude-code",
    });
    expect(JSON.parse(r.value_json)).toBe("claude-code");
  });

  test("non-string values (arrays, objects) pass through unwrapped", async () => {
    transport.register("admin/scoping/set", () => ({ row: row({ key: "flow.allowlist", value_json: '["docs"]' }) }));
    await admin.scopingSet({
      scope_kind: "tenant",
      scope_id: "default",
      key: "flow.allowlist",
      value: ["docs", "fix-bug"],
    });
    // Critical: the wrapper must NOT JSON.stringify the value -- the server
    // takes the raw JS value and stringifies it itself. Otherwise the row's
    // value_json would be the double-encoded string `"[\"docs\",...]"`.
    expect(transport.calls[0].params.value).toEqual(["docs", "fix-bug"]);
  });
});

describe("adminApi.scopingDelete", () => {
  test("by id -- dispatches with { id } and unwraps ok flag", async () => {
    transport.register("admin/scoping/delete", () => ({ ok: true }));
    const ok = await admin.scopingDelete({ id: "s-1" });
    expect(transport.calls).toEqual([{ method: "admin/scoping/delete", params: { id: "s-1" } }]);
    expect(ok).toBe(true);
  });

  test("by composite -- dispatches with the full triple", async () => {
    transport.register("admin/scoping/delete", () => ({ ok: true }));
    await admin.scopingDelete({ scope_kind: "team", scope_id: "tm-eng", key: "model" });
    expect(transport.calls[0].params).toEqual({ scope_kind: "team", scope_id: "tm-eng", key: "model" });
  });

  test("ok=false from the server surfaces verbatim (already-deleted case)", async () => {
    transport.register("admin/scoping/delete", () => ({ ok: false }));
    const ok = await admin.scopingDelete({ id: "s-ghost" });
    expect(ok).toBe(false);
  });
});
