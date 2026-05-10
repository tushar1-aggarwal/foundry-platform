/**
 * Agent resolution for dispatch.
 *
 * Dispatch accepts either a string name (looked up via the agent store) or an
 * inline AgentSpec object (built in-place). After resolution we also apply the
 * stage-level model override and the model-catalog slug normalisation.
 *
 * All side-effects (logging) are routed through the caller-supplied `log`.
 */

import type { DispatchDeps } from "./types.js";
import type { AgentDefinition } from "../../agent/agent.js";
import type { Session } from "../../../types/index.js";
import type { StageDefinition } from "../flow.js";
import { sessionAsVars } from "../task-builder.js";
import { logInfo } from "../../observability/structured-log.js";

export type AgentRef = StageDefinition["agent"];

export interface ResolvedAgent {
  agent: AgentDefinition;
  agentName: string;
}

/**
 * Resolve an agent reference. Inline specs are built via buildInlineAgent;
 * named refs go through the agent registry, with a fallback to the server's
 * cwd project root (web-UI-created agents save relative to server cwd, which
 * may differ from the session's workdir).
 */
export async function resolveDispatchAgent(
  deps: Pick<DispatchDeps, "getApp" | "resolveAgent">,
  session: Session,
  agentRef: AgentRef,
  projectRoot: string | undefined,
  log: (msg: string) => void,
): Promise<{ ok: true; resolved: ResolvedAgent } | { ok: false; message: string }> {
  if (typeof agentRef === "object" && agentRef !== null) {
    // Inline agent: build AgentDefinition in-place, apply runtime merge via
    // buildInlineAgent so runtime defaults (model, env, etc.) are respected
    // the same way as stored agents.
    const { buildInlineAgent } = await import("../../agent/agent.js");
    const agent = buildInlineAgent(deps.getApp(), agentRef, sessionAsVars(session));
    const agentName = agent?.name ?? "inline";
    if (!agent) return { ok: false, message: `Inline agent build failed (missing runtime or system_prompt?)` };
    return { ok: true, resolved: { agent, agentName } };
  }

  const agentName = agentRef!;
  log(`Resolving agent: ${agentName}`);
  let agent = deps.resolveAgent(agentName, sessionAsVars(session), { projectRoot }) as AgentDefinition | null;
  if (!agent) {
    const { findProjectRoot } = await import("../../agent/agent.js");
    const serverRoot = findProjectRoot(process.cwd()) ?? undefined;
    if (serverRoot && serverRoot !== projectRoot) {
      agent = deps.resolveAgent(agentName, sessionAsVars(session), {
        projectRoot: serverRoot,
      }) as AgentDefinition | null;
    }
  }
  if (!agent) return { ok: false, message: `Agent '${agentName}' not found` };
  return { ok: true, resolved: { agent, agentName } };
}

/**
 * Apply stage-level model override and resolve the catalog slug.
 *
 * - Stage.model overrides agent.model when set (legacy field).
 * - Model catalog then maps (agent.model, runtime.compat) to the concrete
 *   provider slug the runtime should send. Null means "catalog doesn't know
 *   this id"; we leave the model untouched so explicit out-of-band slugs still
 *   pass through.
 */
export function applyStageModelAndResolveSlug(
  deps: Pick<DispatchDeps, "models" | "runtimes">,
  agent: AgentDefinition,
  stageDef: StageDefinition | null,
  projectRoot: string | undefined,
  log: (msg: string) => void,
): void {
  // Stage-level model override (legacy stage.model field) still wins if set.
  if (stageDef?.model) {
    agent.model = stageDef.model;
  }

  // `compat` is a runtime concern, not an agent concern -- look it up off
  // the resolved runtime definition. If the agent's runtime points at a
  // name we can't resolve, treat compat as empty (the resolver falls back
  // to anthropic-direct).
  if (agent.model && deps.models) {
    const runtimeName = agent.runtime;
    const runtimeDef = runtimeName ? deps.runtimes.get(runtimeName) : null;
    const runtimeCompat = runtimeDef?.compat ?? [];
    const resolved = deps.models.resolveSlug(agent.model, runtimeCompat, projectRoot);
    if (resolved && resolved !== agent.model) {
      log(`Catalog: ${agent.model} -> ${resolved} (compat: [${runtimeCompat.join(",")}])`);
      agent.model = resolved;
    }
  }
}

/**
 * Apply a Phase 1 scoping `runtime` hint to a resolved agent. The hint is
 * stashed at `session/start` from the user/team/tenant override chain
 * (already validated against the runtime registry there). At dispatch
 * we either:
 *
 *   - Skip if the agent opts out via `runtime_locked` (logged so ops can
 *     see why an override didn't apply).
 *   - Skip if the runtime was deleted between start and dispatch (rare
 *     race; logged but not fatal -- the in-flight session continues
 *     against the agent's declared runtime).
 *   - Otherwise replace `agent.runtime` and recompute
 *     `_resolved_runtime_type` from the new runtime definition so
 *     downstream type-driven dispatch (executor pick, secrets, env)
 *     uses the right shape.
 *
 * Mutates `agent` in place. Idempotent on a no-hint or no-op.
 */
export function applyScopingRuntimeHint(
  deps: Pick<DispatchDeps, "runtimes">,
  agent: AgentDefinition,
  hint: string | undefined,
  log: (msg: string) => void,
): void {
  if (!hint) return;
  // Emit on BOTH the streaming dispatch log (for live subscribers) and
  // the structured-log channel (for ops grep / dashboards). The streaming
  // log defaults to a no-op for non-streaming dispatches, so a structured
  // log entry is the only durable signal that the hook fired.
  if (agent.runtime_locked) {
    const msg = `runtime hint '${hint}' ignored (agent '${agent.name}' has runtime_locked)`;
    log(msg);
    logInfo("scoping", msg);
    return;
  }
  const def = deps.runtimes.get(hint);
  if (!def) {
    const msg = `runtime hint '${hint}' no longer registered; falling back to '${agent.runtime}'`;
    log(msg);
    logInfo("scoping", msg);
    return;
  }
  const msg = `runtime hint '${hint}' applied (was '${agent.runtime}', agent '${agent.name}')`;
  log(msg);
  logInfo("scoping", msg);
  agent.runtime = hint;
  agent._resolved_runtime_type = def.type;
}

/**
 * Apply a Phase 1 scoping `model` hint to a resolved agent. The hint
 * is stashed at `session/start` from the user/team/tenant override
 * chain (already validated against the global model catalog there).
 * At dispatch we either:
 *
 *   - Skip if the agent opts out via `model_locked` (the load-bearing
 *     case: cost-pinned agents intentionally pinned to a cheap model
 *     do not get silently bumped to a more expensive override).
 *   - Skip if the model was removed from the catalog between start
 *     and dispatch (rare; logged but not fatal).
 *   - Otherwise replace `agent.model` and let
 *     `applyStageModelAndResolveSlug` run afterwards to (a) honor a
 *     stage-level `stage.model` if set (it always wins) and (b)
 *     resolve the catalog slug under the agent's effective runtime.
 *
 * Must be called BEFORE `applyStageModelAndResolveSlug` so the
 * catalog resolution sees the post-hint model. Mutates `agent` in
 * place. Idempotent on a no-hint or no-op.
 */
export function applyScopingModelHint(
  deps: Pick<DispatchDeps, "models">,
  agent: AgentDefinition,
  hint: string | undefined,
  projectRoot: string | undefined,
  log: (msg: string) => void,
): void {
  if (!hint) return;
  if (agent.model_locked) {
    const msg = `model hint '${hint}' ignored (agent '${agent.name}' has model_locked)`;
    log(msg);
    logInfo("scoping", msg);
    return;
  }
  // Validate against the catalog (passing projectRoot so a
  // project-registered model is also accepted at dispatch even if it
  // wasn't visible at session/start). If the model has been removed
  // entirely between start and dispatch, drop the hint -- don't fail
  // an in-flight session for an upstream config edit.
  const def = deps.models?.get(hint, projectRoot);
  if (!def) {
    const msg = `model hint '${hint}' no longer in catalog; falling back to '${agent.model}'`;
    log(msg);
    logInfo("scoping", msg);
    return;
  }
  const msg = `model hint '${hint}' applied (was '${agent.model}', agent '${agent.name}')`;
  log(msg);
  logInfo("scoping", msg);
  agent.model = hint;
}
