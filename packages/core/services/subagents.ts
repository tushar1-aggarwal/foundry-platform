/**
 * Subagent spawning -- independent child sessions with their own model/agent.
 *
 * Extracted from stage-orchestrator.ts. Unlike fork (which copies the parent's
 * config), subagents can use different models and agents for cost optimization
 * or specialization.
 */

import type { OrchestrationDeps } from "./deps.js";
import * as flow from "./flow.js";

/**
 * Spawn a subagent -- an independent child session with its own agent.
 * Unlike fork (which copies the parent's config), subagents can pick a
 * different agent for specialization. Per-subsession model selection now
 * flows through the agent definition (or an inline agent on the flow
 * stage) -- dispatch no longer reads a session-level `model_override`.
 */
export async function spawnSubagent(
  deps: OrchestrationDeps,
  parentId: string,
  opts: {
    task: string;
    agent?: string;
    group_name?: string;
    extensions?: string[];
  },
): Promise<{ ok: boolean; sessionId?: string; message: string }> {
  const parent = await deps.sessions.get(parentId);
  if (!parent) return { ok: false, message: "Parent session not found" };

  const session = await deps.sessions.create({
    summary: opts.task,
    repo: parent.repo || undefined,
    flow: "quick",
    compute_name: parent.compute_name || undefined,
    workdir: parent.workdir || undefined,
    group_name: opts.group_name ?? parent.group_name ?? undefined,
    orchestrator: "temporal",
    config: {
      parent_id: parentId,
      subagent: true,
      extensions: opts.extensions,
    },
  });

  const agentName = opts.agent ?? parent.agent;
  await deps.sessions.update(session.id, { agent: agentName, parent_id: parentId });

  // Set first stage so the subagent is dispatchable
  const firstStage = await flow.getFirstStage(deps, "quick");
  if (firstStage) {
    await deps.sessions.update(session.id, { stage: firstStage, status: "ready" });
  }

  await deps.events.log(session.id, "subagent_spawned", {
    actor: "system",
    data: { parent_id: parentId, task: opts.task, agent: agentName },
  });

  // The subagent is an independent Temporal-driven session: its
  // sessionWorkflow loop dispatches the (single) "quick" stage.
  await deps.app!.sessionService.startWorkflowFor(session.id, "quick");
  return { ok: true, sessionId: session.id, message: `Subagent ${session.id} spawned` };
}

/**
 * Spawn multiple subagents in parallel and optionally wait for all to complete.
 */
export async function spawnParallelSubagents(
  deps: OrchestrationDeps,
  parentId: string,
  tasks: Array<{
    task: string;
    agent?: string;
  }>,
): Promise<{ ok: boolean; sessionIds: string[]; message: string }> {
  const ids: string[] = [];
  for (const t of tasks) {
    const result = await spawnSubagent(deps, parentId, t);
    if (result.ok && result.sessionId) {
      ids.push(result.sessionId);
    }
  }
  // Each subagent's Temporal sessionWorkflow (started in spawnSubagent)
  // drives its own dispatch; no explicit dispatch loop here.
  return { ok: true, sessionIds: ids, message: `${ids.length} subagents spawned and dispatched` };
}
