/**
 * Central dispatch for typed-secret placement.
 *
 * Loads every secret (string + blob) for the session's tenant, applies an
 * optional narrowing filter, and routes each ref through the placer
 * registered for its `type`. Per-type failure policy:
 *
 *  - Types in FAIL_FAST throw on any placer error (env-var / ssh-private-key
 *    / kubeconfig: missing them silently breaks the agent in subtle ways).
 *  - All other types (generic-blob in Phase 3) log a warning and continue.
 *
 * Unknown types (no registered placer) are skipped at debug level. This
 * allows older clusters to surface forward-incompatible types without
 * blowing up dispatch.
 *
 * Env-var vs blob asymmetry:
 *   When `opts.envVars` is provided, env-var-typed placement is sourced
 *   from that map (the HierarchicalSecretResolver's effective env-var
 *   set, walked user -> team -> tenant). Env-var entries in the flat
 *   tenant list are SKIPPED to avoid (a) clobbering user/team scope with
 *   tenant values and (b) leaking path-shaped storage keys
 *   (`/ark/<tid>/users/<uid>/<KEY>`) into env-var-name validation.
 *
 *   Typed-blob placement (ssh-private-key, generic-blob, kubeconfig)
 *   still iterates the flat tenant table -- blob/file names are
 *   env-var-shape-validated on write, so the flat list cannot leak
 *   path-shaped names for those types. A scope-aware story for typed
 *   blobs is a separate follow-up.
 */

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import type { PlacementCtx, TypedSecret, TypedSecretPlacer } from "./placement-types.js";
import { envVarPlacer } from "./placers/env-var.js";
import { sshPrivateKeyPlacer } from "./placers/ssh-private-key.js";
import { logInfo, logWarn, logDebug } from "../observability/structured-log.js";

const PLACERS: Record<string, TypedSecretPlacer> = {
  "env-var": envVarPlacer,
  "ssh-private-key": sshPrivateKeyPlacer,
  // generic-blob, kubeconfig registered in Phase 3
};

/** Per-type failure policy. Mutable at runtime so tests can register stubs. */
const FAIL_FAST = new Set<string>(["env-var", "ssh-private-key", "kubeconfig"]);

export interface PlaceAllSecretsOpts {
  /** When set, only these secret names are eligible. */
  narrow?: ReadonlySet<string>;
  /**
   * Pre-resolved env-var set from HierarchicalSecretResolver. When set,
   * env-var-typed placement is sourced from this map; flat-table
   * iteration handles only typed blobs/files. Keys are bare env-var
   * names (validated `[A-Z0-9_]+`) -- never path-shaped storage keys.
   */
  envVars?: Record<string, string>;
}

export async function placeAllSecrets(
  app: AppContext,
  session: Session,
  ctx: PlacementCtx,
  opts: PlaceAllSecretsOpts = {},
): Promise<void> {
  const tenantId = session.tenant_id ?? app.config.authSection.defaultTenant ?? "default";

  const stringRefs = await app.secrets.list(tenantId);
  const blobRefs = await app.secrets.listBlobsDetailed(tenantId);

  // Narrowing filter applies only to env-var-typed secrets -- the historical
  // semantic of stage/runtime YAML `secrets: [NAME]` lists is "include these
  // env vars at minimum". File/blob-typed secrets (ssh keys, kubeconfigs,
  // generic blobs) auto-attach regardless so a session can use git+ssh
  // without every runtime YAML having to enumerate the keypair name.
  const eligible = <T extends { name: string; type: string }>(refs: T[]): T[] =>
    opts.narrow ? refs.filter((r) => r.type !== "env-var" || opts.narrow!.has(r.name)) : refs;

  const stringSelected = eligible(stringRefs);
  const blobSelected = eligible(blobRefs);

  // Env-var-typed placement source. When `opts.envVars` is provided we
  // use it instead of the flat tenant list -- the resolver has already
  // walked user -> team -> tenant precedence and produced bare env-var
  // names. Skip env-var entries in the flat-list loop below so we don't
  // re-emit them (potentially with stale tenant values).
  if (opts.envVars) {
    const placer = PLACERS["env-var"];
    if (placer) {
      for (const [name, value] of Object.entries(opts.envVars)) {
        if (opts.narrow && !opts.narrow.has(name)) continue;
        const secret: TypedSecret = {
          name,
          type: "env-var",
          metadata: {},
          value,
        };
        try {
          await placer.place(secret, ctx);
          logInfo("general", `secret_placed name=${name} type=env-var session=${session.id}`);
        } catch (e: any) {
          const msg = `secret_placement_failed name=${name} type=env-var: ${e?.message ?? e}`;
          if (FAIL_FAST.has("env-var")) throw new Error(msg);
          logWarn("general", msg);
        }
      }
    }
  }

  const stringNamesToResolve = opts.envVars
    ? stringSelected.filter((r) => r.type !== "env-var").map((r) => r.name)
    : stringSelected.map((r) => r.name);
  const stringValues = stringNamesToResolve.length
    ? await app.secrets.resolveMany(tenantId, stringNamesToResolve)
    : {};

  for (const ref of stringSelected) {
    // When `opts.envVars` is provided, env-var-typed placement was handled
    // above; skip here to avoid double-emission (and to keep path-shaped
    // names from leaking through envVarPlacer).
    if (opts.envVars && ref.type === "env-var") continue;
    const placer = PLACERS[ref.type];
    if (!placer) {
      logDebug("general", `secret_skipped: unknown_type type=${ref.type} name=${ref.name}`);
      continue;
    }
    const secret: TypedSecret = {
      name: ref.name,
      type: ref.type,
      metadata: ref.metadata,
      value: stringValues[ref.name],
    };
    try {
      await placer.place(secret, ctx);
      logInfo("general", `secret_placed name=${ref.name} type=${ref.type} session=${session.id}`);
    } catch (e: any) {
      const msg = `secret_placement_failed name=${ref.name} type=${ref.type}: ${e?.message ?? e}`;
      if (FAIL_FAST.has(ref.type)) throw new Error(msg);
      logWarn("general", msg);
    }
  }

  for (const ref of blobSelected) {
    const placer = PLACERS[ref.type];
    if (!placer) {
      logDebug("general", `secret_skipped: unknown_type type=${ref.type} name=${ref.name}`);
      continue;
    }
    const files = await app.secrets.getBlob(tenantId, ref.name);
    if (!files) {
      logWarn("general", `blob_disappeared name=${ref.name}`);
      continue;
    }
    const secret: TypedSecret = {
      name: ref.name,
      type: ref.type,
      metadata: ref.metadata,
      files,
    };
    try {
      await placer.place(secret, ctx);
      logInfo("general", `secret_placed name=${ref.name} type=${ref.type} session=${session.id}`);
    } catch (e: any) {
      const msg = `secret_placement_failed name=${ref.name} type=${ref.type}: ${e?.message ?? e}`;
      if (FAIL_FAST.has(ref.type)) throw new Error(msg);
      logWarn("general", msg);
    }
  }
}

/** @internal -- exported for tests so they can inject stub placers. */
export function __test_registerPlacer(type: string, placer: TypedSecretPlacer): void {
  PLACERS[type] = placer;
}

/** @internal -- exported for tests so they can mark a stub placer as fail-fast. */
export function __test_addFailFast(type: string): void {
  FAIL_FAST.add(type);
}
