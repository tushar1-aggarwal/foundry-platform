/**
 * Per-stage compute resolution.
 *
 * Resolution is uniform regardless of which axis the stage used
 * (`stageDef.compute` = existing concrete ref, or `stageDef.compute_template`
 * = a template to materialize).
 *
 * Behavior:
 *   - Named row not found -> fall through to the config-defined template
 *     catalog (seed a template row); still not found -> return null.
 *   - Row found (template OR concrete) -> resolve to the row name. A
 *     template is MATERIALIZED per session by the provision path: it mints
 *     an ephemeral pod from the template spec and binds it to the session
 *     via the handle. No row is cloned here -- the template stays a
 *     read-only spec and the pod is reaped on terminal.
 */

import type { DispatchDeps } from "./types.js";
import type { StageDefinition } from "../flow.js";

export class ComputeResolver {
  constructor(private readonly deps: Pick<DispatchDeps, "computes" | "computeService" | "config">) {}

  async resolveForStage(
    stageDef: StageDefinition | null,
    _sessionId: string,
    log: (msg: string) => void = () => {},
  ): Promise<string | null> {
    const ref = stageDef?.compute ?? stageDef?.compute_template;
    if (!ref) return null;

    const existing = await this.deps.computes.get(ref);

    if (!existing) {
      // Fallback: config-defined template catalog lets users declare
      // templates in ~/.ark/config.yaml without hitting the DB. Seed a
      // template row so resolveComputeTarget can build a target from it.
      const cfgTmpl = (this.deps.config.computeTemplates ?? []).find((t) => t.name === ref);
      if (cfgTmpl) {
        log(`Seeding template '${ref}' from config`);
        const { compute, isolation } = templateAxesFromConfig(cfgTmpl);
        await this.deps.computeService.create({
          name: cfgTmpl.name,
          compute,
          isolation,
          config: cfgTmpl.config,
          is_template: true,
        });
        return cfgTmpl.name;
      }
      log(`Stage compute '${ref}' not found, falling back to session default`);
      return null;
    }

    // Template or concrete: resolve to the row name. A template is
    // materialized per session by the provision path (an ephemeral pod
    // bound to the session via its handle); no row is cloned here.
    return existing.name;
  }
}

/**
 * Resolve the (compute, isolation) pair for a config-defined template. Config
 * still carries a single `provider` string for back-compat; this helper maps
 * the well-known names back onto the two-axis representation. Unknown names
 * default to `local + direct`.
 */
function templateAxesFromConfig(t: { provider?: string; compute?: string; isolation?: string }): {
  compute: import("../../../types/index.js").ComputeKindName;
  isolation: import("../../../types/index.js").IsolationKindName;
} {
  if (t.compute && t.isolation) {
    return {
      compute: t.compute as import("../../../types/index.js").ComputeKindName,
      isolation: t.isolation as import("../../../types/index.js").IsolationKindName,
    };
  }
  switch (t.provider) {
    case "local":
      return { compute: "local", isolation: "direct" };
    case "docker":
      return { compute: "local", isolation: "docker" };
    case "devcontainer":
      return { compute: "local", isolation: "devcontainer" };
    case "firecracker":
      return { compute: "firecracker", isolation: "direct" };
    case "ec2":
    case "remote-arkd":
    case "remote-worktree":
      return { compute: "ec2", isolation: "direct" };
    case "ec2-docker":
    case "remote-docker":
      return { compute: "ec2", isolation: "docker" };
    case "ec2-devcontainer":
    case "remote-devcontainer":
      return { compute: "ec2", isolation: "devcontainer" };
    case "k8s":
      return { compute: "k8s", isolation: "direct" };
    case "k8s-kata":
      return { compute: "k8s-kata", isolation: "direct" };
    default:
      return { compute: "local", isolation: "direct" };
  }
}
