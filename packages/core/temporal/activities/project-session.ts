import type { ProjectionInput } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("projectSessionActivity: deps not injected");
  return _deps;
}

export async function projectSessionActivity(input: ProjectionInput): Promise<void> {
  const d = deps();
  if (Object.keys(input.patch).length > 0) {
    await (d.sessions as any).update(input.sessionId, input.patch);
  }
}
