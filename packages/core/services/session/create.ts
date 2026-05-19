/**
 * SessionCreator -- start a new session, record its usage, resolve its
 * GitHub origin. Extracted from the old session-lifecycle.ts.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";

import type { Session } from "../../../types/index.js";
import type { SessionLifecycleDeps, StartSessionOpts } from "./types.js";
import * as flow from "../flow.js";
import { loadRepoConfig } from "../../repo-config.js";
import { profileGroupPrefix } from "../profile.js";
import { logError, logWarn } from "../../observability/structured-log.js";
import { track } from "../../observability/telemetry.js";
import { emitSessionSpanStart, emitStageSpanStart } from "../../observability/otlp.js";
import { isRepoUrl } from "../../repo-url.js";

/** Resolve GitHub repo URL from a local git directory. Returns null if not a GitHub repo. */
export function resolveGitHubUrl(dir?: string | null): string | null {
  if (!dir) return null;
  // Skip git when `dir` clearly isn't a local checkout. Remote-repo sessions
  // pass the URL basename (e.g. "recharge-h5-pos") here before the clone has
  // landed -- shelling out to `git -C <basename>` produces "fatal: cannot
  // change to ..." log noise on every retry without surfacing any signal.
  if (isRepoUrl(dir) || !existsSync(dir)) return null;
  try {
    const remote = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    const sshMatch = remote.match(/git@github\.com:([^/]+\/[^.]+)/);
    if (sshMatch) return `https://github.com/${sshMatch[1]}`;
    const httpsMatch = remote.match(/(https:\/\/github\.com\/[^/]+\/[^/.]+)/);
    if (httpsMatch) return httpsMatch[1];
    return null;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!msg.includes("not a git repository") && !msg.includes("No such remote")) {
      logWarn("session", `resolveGitHubUrl: ${msg}`);
    }
    return null;
  }
}

export class SessionCreator {
  constructor(private readonly deps: SessionLifecycleDeps) {}

  async start(opts: StartSessionOpts): Promise<Session> {
    const d = this.deps;
    const repoDir = opts.workdir ?? opts.repo;
    const repoConfig = repoDir ? loadRepoConfig(repoDir) : {};

    const prefix = profileGroupPrefix();
    const rawGroup = opts.group_name ?? repoConfig.group;
    const groupName = prefix ? `${prefix}${rawGroup ?? ""}` : (rawGroup ?? undefined);

    // Inline flow support: callers (CLI, web, RPC) may pass an object literal
    // for `opts.flow` instead of a registered flow name. We normalize that
    // here so the rest of the creator sees a plain string name, then register
    // the definition on the ephemeral overlay + persist it to session.config
    // for daemon-restart rehydration (mirrors the for_each spawn pattern).
    let resolvedFlowName: string | undefined;
    let inlineFlowDef: import("../flow.js").FlowDefinition | undefined;
    const flowRef = opts.flow ?? repoConfig.flow;
    if (typeof flowRef === "object" && flowRef !== null) {
      const raw = flowRef as import("../../../types/index.js").InlineFlowInput;
      if (!Array.isArray(raw.stages) || raw.stages.length === 0) {
        throw new Error("Inline flow must have at least one stage");
      }
      inlineFlowDef = {
        name: raw.name ?? "inline",
        description: raw.description,
        stages: raw.stages as unknown as import("../flow.js").StageDefinition[],
      };
      resolvedFlowName = inlineFlowDef.name;
    } else {
      resolvedFlowName = flowRef;
    }

    // compute_name fallback chain: explicit arg > per-repo config > "local".
    // Without the trailing "local" default, sessions dispatched with no
    // explicit compute landed in the DB with NULL compute_name even though
    // the rest of the system implicitly resolves them to local. The compute
    // panel's "Sessions on this compute" filter then matched them against
    // every compute (NULL == NULL trick or fallback-on-null), so one
    // session appeared under multiple compute panels. See #472.
    const mergedOpts: Record<string, unknown> = {
      ...opts,
      flow: resolvedFlowName,
      compute_name: opts.compute_name ?? repoConfig.compute ?? "local",
      group_name: groupName,
      workspace_id: opts.workspace_id ?? null,
    };
    // Agent override: inline agents are not persistable as a session.agent
    // name; we leave session.agent null and let the inline definition flow
    // through the inline flow's stage.agent object.
    if (opts.agent !== undefined && typeof opts.agent === "object" && opts.agent !== null) {
      // An inline agent was passed at session start without an inline flow.
      // Build a one-stage inline flow around it so the executor has something
      // to dispatch. This is the same pattern the web UI uses via stage.agent
      // object literals; we just hoist it to the top level for CLI convenience.
      if (!inlineFlowDef) {
        inlineFlowDef = {
          name: "inline",
          stages: [
            {
              name: "main",
              agent: opts.agent as unknown as import("../flow.js").InlineAgentSpec,
              gate: "auto",
            } as import("../flow.js").StageDefinition,
          ],
        };
        resolvedFlowName = inlineFlowDef.name;
        mergedOpts.flow = resolvedFlowName;
      }
      delete (mergedOpts as Record<string, unknown>).agent;
    }

    const repoUrl = resolveGitHubUrl(opts.workdir ?? opts.repo);
    if (repoUrl) {
      mergedOpts.config = { ...((mergedOpts.config as Record<string, unknown>) ?? {}), github_url: repoUrl };
    }

    if (opts.attachments?.length) {
      mergedOpts.config = {
        ...((mergedOpts.config as Record<string, unknown>) ?? {}),
        attachments: opts.attachments.map((a) => ({
          name: a.name,
          content: a.content,
          type: a.type,
        })),
      };
    }

    // Copy every top-level input onto session.config.inputs. Under the
    // flat-bag schema each key is an arbitrary flow input (`targets`,
    // `repos`, `analysis_id`, ...), not just the reserved `files`/`params`
    // sub-buckets. Dropping unrecognised keys would silently orphan
    // everything a flow reads via `{{inputs.<key>}}`.
    if (opts.inputs && Object.keys(opts.inputs).length > 0) {
      mergedOpts.config = {
        ...((mergedOpts.config as Record<string, unknown>) ?? {}),
        inputs: { ...opts.inputs },
      };
    }

    // Temporal is the sole orchestrator: stamp the session before the first
    // DB write so the orchestrator column is correct from creation.
    (mergedOpts as Record<string, unknown>).orchestrator = "temporal";

    const session = await d.sessions.create(mergedOpts as StartSessionOpts);

    // Inline flow persistence + ephemeral registration. We use a per-session
    // synthetic name (`inline-<sessionId>`) so every inline flow lives in its
    // own namespace and overlay reads never collide. The session row's
    // `flow` column is rewritten to that synthetic name for lookup; the
    // definition is stashed under `config.inline_flow` so `_rehydrateInlineFlows`
    // in `app.ts` can re-register it after a daemon restart.
    if (inlineFlowDef) {
      const syntheticName = `inline-${session.id}`;
      const finalDef: import("../flow.js").FlowDefinition = { ...inlineFlowDef, name: syntheticName };
      d.flows.registerInline?.(syntheticName, finalDef);
      await d.sessions.update(session.id, { flow: syntheticName });
      await d.sessions.mergeConfig?.(session.id, { inline_flow: finalDef });
      (session as { flow: string }).flow = syntheticName;
    }

    // Workspace-scoped dispatch: lay out ~/.ark/workspaces/<session_id>/.
    if (mergedOpts.workspace_id) {
      const wsId = mergedOpts.workspace_id as string;
      const ws = await d.workspaces.getWorkspace(wsId);
      if (!ws) {
        throw new Error(`workspace ${wsId} not found; cannot dispatch session ${session.id}`);
      }
      const reposInWs = opts.repo ? await d.workspaces.listReposInWorkspace(ws.tenant_id, ws.id) : [];
      const primaryRepoId =
        opts.repo && ws
          ? (reposInWs.find((r) => r.name === opts.repo || r.local_path === opts.repo || r.repo_url === opts.repo)
              ?.id ?? null)
          : null;
      const wsWorkdir = await d.provisionWorkspaceWorkdir(session, ws, { primaryRepoId });
      await d.sessions.update(session.id, { workdir: wsWorkdir });
      (session as { workdir: string | null }).workdir = wsWorkdir;
    }

    await d.events.log(session.id, "session_created", {
      actor: "user",
      data: {
        summary: opts.summary,
        flow: session.flow ?? "default",
        // Inline agents don't have a persistable name; log only string refs.
        agent: typeof opts.agent === "string" ? opts.agent : null,
        compute: (mergedOpts.compute_name as string | undefined) ?? "local",
        repo: opts.repo ?? opts.workdir ?? null,
        group: (mergedOpts.group_name as string | undefined) ?? null,
      },
    });

    track("session_created", { flow: session.flow ?? "default" });

    if (typeof opts.agent === "string" && opts.agent) {
      await d.sessions.update(session.id, { agent: opts.agent });
    }

    // services/flow reads app.flows via AppContext; shim a tiny
    // AppContext-alike to satisfy the helpers' signature.
    const flowName = session.flow ?? "default";
    const flowShim = { flows: d.flows } as unknown as Parameters<typeof flow.getFirstStage>[0];
    const firstStage = await flow.getFirstStage(flowShim, flowName);
    if (firstStage) {
      const action = await flow.getStageAction(flowShim, flowName, firstStage);
      const firstStageDef = await flow.getStage(flowShim, flowName, firstStage);
      const stageUpdate: Record<string, unknown> = { stage: firstStage, status: "ready" };
      // `compute_template:` names a template to materialize per session: the
      // generic provision path mints an ephemeral pod from the template spec
      // and binds it to the session via the handle (no row is cloned). Point
      // the session at the template; an explicit caller compute_name wins.
      if (firstStageDef?.compute_template && opts.compute_name == null) {
        stageUpdate.compute_name = firstStageDef.compute_template;
      }
      await d.sessions.update(session.id, stageUpdate);
      await d.events.log(session.id, "stage_ready", {
        stage: firstStage,
        actor: "system",
        data: { stage: firstStage, gate: "auto", stage_type: action.type, stage_agent: action.agent },
      });

      emitSessionSpanStart(session.id, {
        flow: flowName,
        repo: opts.repo,
        agent: opts.agent ?? undefined,
      });
      const agentLabel =
        typeof action.agent === "string" ? action.agent : ((action.agent as { name?: string })?.name ?? "inline");
      emitStageSpanStart(session.id, { stage: firstStage, agent: agentLabel, gate: "auto" });
    }

    // Start the Temporal workflow and stamp workflow_id on the row. Runs
    // after the stage/status columns are set so the worker picks up an
    // already-advanced session when it first queries.
    const tenantId = d.sessions.getTenant?.() ?? "default";
    const { workflowId, runId } = await d.startTemporalWorkflow(session.id, flowName, tenantId);
    await d.sessions.update(session.id, {
      workflow_id: workflowId,
      workflow_run_id: runId,
    } as Partial<Session>);

    return (await d.sessions.get(session.id))!;
  }

  /**
   * Record token usage from a session transcript into UsageRecorder.
   * Resolves the runtime's billing mode (api/subscription/free) so that
   * subscription-based runtimes get cost_usd=0 while still tracking tokens.
   */
  async recordUsage(
    session: Session,
    usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number },
    provider: string,
    source: string,
  ): Promise<void> {
    if (!usage.input_tokens && !usage.output_tokens) return;
    try {
      const d = this.deps;
      const runtimeName =
        (session.config?.launch_executor as string | undefined) ?? (session.config?.runtime as string | undefined);
      if (!runtimeName) {
        logWarn("session", `recordUsage: no runtime resolvable for session ${session.id} -- skipping`);
        return;
      }
      const runtime = await d.runtimes.get(runtimeName);
      const billingMode = runtime?.billing?.mode ?? "api";
      // Runtime no longer owns a default_model. Fall back to "sonnet" (a
      // catalog alias) when neither the session nor the agent carries a model;
      // usage recording only needs *some* label, not an accurate slug.
      const model = (session.config?.model as string | undefined) ?? "sonnet";

      d.usageRecorder.record({
        sessionId: session.id,
        tenantId: session.tenant_id ?? "default",
        userId: session.user_id ?? "system",
        model,
        provider,
        runtime: runtimeName,
        agentRole: session.agent ?? undefined,
        usage,
        source,
        costMode: billingMode,
      });
    } catch (e: any) {
      logError("session", "usage record failed", { sessionId: session.id, error: String(e?.message ?? e) });
    }
  }
}
