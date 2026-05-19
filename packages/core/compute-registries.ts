/**
 * In-memory registries for the `Compute` / `Isolation` kinds.
 *
 * Lives on AppContext because impls are registered imperatively at boot.
 * Keeping the maps + mutators here keeps app.ts focused on lifecycle.
 */
import type { Compute as NewCompute, Isolation as NewIsolation, ComputeKind, IsolationKind } from "./compute/types.js";

export class ComputeRegistries {
  private computes = new Map<ComputeKind, NewCompute>();
  private isolations = new Map<IsolationKind, NewIsolation>();

  registerCompute(c: NewCompute): void {
    this.computes.set(c.kind, c);
  }
  registerIsolation(r: NewIsolation): void {
    this.isolations.set(r.kind, r);
  }
  getCompute(k: ComputeKind): NewCompute | null {
    return this.computes.get(k) ?? null;
  }
  getIsolation(k: IsolationKind): NewIsolation | null {
    return this.isolations.get(k) ?? null;
  }
  listComputes(): ComputeKind[] {
    return [...this.computes.keys()];
  }
  listIsolations(): IsolationKind[] {
    return [...this.isolations.keys()];
  }
}
