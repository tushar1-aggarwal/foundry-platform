import type { OrchestrationDeps } from "../../services/deps.js";
import type { StageDefinition } from "../../services/flow.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("loadFlowActivity: deps not injected");
  return _deps;
}

/**
 * Plain-object representation of a stage returned to the workflow.
 * JSON-serializable - no class instances or Date objects.
 */
export interface LoadedStage {
  name: string;
  gate: string;
  depends_on: string[];
  [key: string]: unknown;
}

/**
 * Result returned by loadFlowActivity.
 * JSON-serializable: plain objects only.
 */
export interface LoadedFlow {
  name: string;
  stages: LoadedStage[];
  /** Topological order as indices into `stages`. */
  topoOrder: number[];
}

/**
 * Kahn's algorithm topological sort on stages.
 * Returns indices into the `stages` array in topological order.
 * Throws if a cycle is detected.
 */
function topoSort(stages: LoadedStage[]): number[] {
  const nameToIdx = new Map<string, number>();
  for (let i = 0; i < stages.length; i++) {
    nameToIdx.set(stages[i].name, i);
  }

  // Build adjacency list and in-degree map (edge: dep -> stage)
  const inDegree = new Array<number>(stages.length).fill(0);
  const adj: number[][] = stages.map(() => []);

  for (let i = 0; i < stages.length; i++) {
    const deps = stages[i].depends_on;
    for (const depName of deps) {
      const depIdx = nameToIdx.get(depName);
      if (depIdx === undefined) {
        throw new Error(`Stage '${stages[i].name}' depends on unknown stage '${depName}'`);
      }
      adj[depIdx].push(i);
      inDegree[i]++;
    }
  }

  // Kahn's BFS
  const queue: number[] = [];
  for (let i = 0; i < stages.length; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  const order: number[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const next of adj[node]) {
      inDegree[next]--;
      if (inDegree[next] === 0) queue.push(next);
    }
  }

  if (order.length !== stages.length) {
    throw new Error("flow has dependency cycle");
  }

  return order;
}

/**
 * Load a flow definition by name and compute topological stage order.
 * Returns a JSON-serializable plain object suitable for use by Temporal workflows.
 */
export async function loadFlowActivity(input: { flowName: string }): Promise<LoadedFlow> {
  const d = deps();
  const raw = d.flows.get(input.flowName);

  // Handle async stores (hosted DB) - await if Promise
  const flowDef =
    raw && typeof (raw as { then?: unknown }).then === "function"
      ? await (raw as Promise<import("../../services/flow.js").FlowDefinition | null>)
      : (raw as import("../../services/flow.js").FlowDefinition | null);

  if (!flowDef) {
    throw new Error(`Flow not found: ${input.flowName}`);
  }

  // Convert stages to plain serializable objects
  const stages: LoadedStage[] = (flowDef.stages ?? []).map((s: StageDefinition) => {
    const plain: LoadedStage = {
      ...s,
      name: s.name,
      gate: s.gate ?? "auto",
      depends_on: (s as any).depends_on ?? [],
    };
    return plain;
  });

  const topoOrder = topoSort(stages);

  return {
    name: flowDef.name,
    stages,
    topoOrder,
  };
}
