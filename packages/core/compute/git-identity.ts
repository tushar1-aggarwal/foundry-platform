/**
 * Resolve the agent's git commit identity for remote computes whose
 * worktree lives in a sandbox pod / EC2 instance / Firecracker VM rather
 * than on the conductor's filesystem.
 *
 * The conductor-side `applyWorktreeGitIdentity` (services/worktree/setup.ts)
 * NEVER runs for these computes because `setupSessionWorktree` short-
 * circuits when supportsWorktree=false. Without this helper, the sandbox
 * has no git config and the LLM agent invents an identity at commit time
 * (e.g. "Planner <planner@foundry.local>"), which Bitbucket's BB Violator
 * rewrites away.
 *
 * Resolution chain (first non-placeholder wins, BOTH name+email must
 * resolve together at each step to avoid mismatched-half identities):
 *
 *   1. app.config.git.{authorName, authorEmail}            -- YAML / programmatic
 *   2. ARK_GIT_AUTHOR_NAME / ARK_GIT_AUTHOR_EMAIL env       -- operator override
 *   3. tenant secret via app.secrets.get(tenantId, KEY)     -- per-tenant identity
 *   4. placeholder "Ark Agent" / "agent@ark.local"          -- last resort
 *
 * The placeholder is treated as "no override" at step 1, matching the
 * existing conductor-side resolver semantics.
 */

import type { AppContext } from "../app.js";

const PLACEHOLDER_NAME = "Ark Agent";
const PLACEHOLDER_EMAIL = "agent@ark.local";

export interface AgentIdentity {
  name: string;
  email: string;
}

function isPlaceholder(name: string | undefined | null, email: string | undefined | null): boolean {
  return !name || !email || name === PLACEHOLDER_NAME || email === PLACEHOLDER_EMAIL;
}

export async function resolveAgentIdentityForRemoteCompute(app: AppContext, tenantId: string): Promise<AgentIdentity> {
  // 1. app.config.git override. Optional-chained so stub apps without a
  // resolved AppConfig (test fixtures) skip straight to the next step
  // instead of throwing on undefined.
  const configName = app.config?.git?.authorName;
  const configEmail = app.config?.git?.authorEmail;
  if (!isPlaceholder(configName, configEmail)) {
    return { name: configName!, email: configEmail! };
  }

  // 2. Env override. Both halves must be set; partial env doesn't match.
  const envName = process.env.ARK_GIT_AUTHOR_NAME;
  const envEmail = process.env.ARK_GIT_AUTHOR_EMAIL;
  if (!isPlaceholder(envName, envEmail)) {
    return { name: envName!, email: envEmail! };
  }

  // 3. Tenant secret backend. Best-effort; missing secrets backend (test
  // fixtures) or transient backend errors don't bubble up because this
  // resolver runs in the dispatch-hot-path.
  try {
    if (app.secrets) {
      const [secretName, secretEmail] = await Promise.all([
        app.secrets.get(tenantId, "ARK_GIT_AUTHOR_NAME"),
        app.secrets.get(tenantId, "ARK_GIT_AUTHOR_EMAIL"),
      ]);
      if (!isPlaceholder(secretName, secretEmail)) {
        return { name: secretName!, email: secretEmail! };
      }
    }
  } catch {
    /* secrets unreachable -- fall through to placeholder */
  }

  // 4. Placeholder. Bitbucket's BB Violator will rewrite this; logs a
  // warning at the caller so operators see the misconfiguration.
  return { name: PLACEHOLDER_NAME, email: PLACEHOLDER_EMAIL };
}

export const _PLACEHOLDER = { name: PLACEHOLDER_NAME, email: PLACEHOLDER_EMAIL };
