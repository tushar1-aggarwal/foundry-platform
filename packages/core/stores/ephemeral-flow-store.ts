/**
 * EphemeralFlowStore -- wraps any FlowStore with an in-memory overlay.
 *
 * Inline flow definitions (from `spawn.flow: <object>` in for_each stages)
 * are registered here under a synthetic name ("inline-{childId}") before the
 * child session is created. All reads via `get()` check the ephemeral layer
 * first, falling back to the backing store for normal named flows.
 *
 * Persistence: inline definitions are also written to the child session's
 * `config.inline_flow` field. On daemon restart, the session repository scan
 * in `app.ts:boot()` calls `registerInline()` to rehydrate them.
 */

import type { FlowStore, FlowSummary } from "./flow-store.js";
import type { FlowDefinition } from "../services/flow.js";

export class EphemeralFlowStore implements FlowStore {
  /** In-memory overlay: ephemeral name -> definition. */
  private readonly overlay = new Map<string, FlowDefinition>();

  constructor(private readonly backing: FlowStore) {}

  // ── Ephemeral registration ─────────────────────────────────────────────

  registerInline(name: string, flow: FlowDefinition): void {
    this.overlay.set(name, flow);
  }

  unregisterInline(name: string): void {
    this.overlay.delete(name);
  }

  // ── FlowStore interface ────────────────────────────────────────────────

  async get(name: string): Promise<FlowDefinition | null> {
    const ephemeral = this.overlay.get(name);
    if (ephemeral !== undefined) return ephemeral;
    return this.backing.get(name);
  }

  async list(): Promise<FlowSummary[]> {
    // Merge: backing list first, then overlay entries (ephemeral last so they
    // don't shadow real flows in UIs that enumerate flows).
    const result = await this.backing.list();
    for (const [name, def] of this.overlay) {
      result.push({
        name,
        description: def.description ?? "",
        stages: def.stages.map((s) => s.name),
        source: "ephemeral",
      });
    }
    return result;
  }

  async save(name: string, flow: FlowDefinition, scope?: "global" | "project"): Promise<void> {
    await this.backing.save(name, flow, scope);
  }

  async delete(name: string, scope?: "global" | "project"): Promise<boolean> {
    return this.backing.delete(name, scope);
  }
}
