/**
 * Contract guard: the hosted wiring is `EphemeralFlowStore` over a
 * DB-backed `DbResourceStore` (see di/persistence.ts). `DbResourceStore`
 * lists asynchronously, so `EphemeralFlowStore.list()` MUST be async and
 * `await` the backing -- otherwise it does `.push()` on a Promise and
 * `flow/list` throws `result.push is not a function` in hosted mode.
 *
 * Regression guard for the 2026-05-17 live-k8s smoke finding. The unit
 * suite never exercised the DB-backed path; this test does.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { DbResourceStore, initResourceDefinitionsTable } from "../db-resource-store.js";
import { EphemeralFlowStore } from "../ephemeral-flow-store.js";
import type { FlowDefinition } from "../../services/flow.js";

let store: EphemeralFlowStore;

beforeEach(async () => {
  const db = new BunSqliteAdapter(new Database(":memory:"));
  await initResourceDefinitionsTable(db);
  const backing = new DbResourceStore<any>(db, "flow", { stages: [] });
  store = new EphemeralFlowStore(backing);
});

describe("EphemeralFlowStore over DbResourceStore (hosted wiring) -- list contract", () => {
  it("list() returns a Promise (async contract, no sync .push on a Promise)", () => {
    const r = store.list();
    expect(r).toBeInstanceOf(Promise);
  });

  it("await list() merges DB-backed flows and ephemeral overlay (no throw)", async () => {
    await store.save("real-flow", { stages: [{ name: "work" }] } as unknown as FlowDefinition);
    store.registerInline("inline-s-abc", {
      description: "inline",
      stages: [{ name: "go" }],
    } as unknown as FlowDefinition);

    // Pre-fix this threw "result.push is not a function".
    const list = await store.list();
    expect(Array.isArray(list)).toBe(true);
    const names = list.map((f) => f.name);
    expect(names).toContain("real-flow");
    expect(names).toContain("inline-s-abc");
    expect(list.find((f) => f.name === "inline-s-abc")?.source).toBe("ephemeral");
  });

  it("await list() on an empty store returns []", async () => {
    expect(await store.list()).toEqual([]);
  });
});
