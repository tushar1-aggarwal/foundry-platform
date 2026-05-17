/**
 * KataCompute -- k8s pod runtime with Kata Containers (microVM isolation).
 *
 * Inherits the full K8sCompute lifecycle but flips two things:
 *   1. Capabilities -- `networkIsolation: true` (Kata gives us a microVM
 *      per pod). `snapshot` stays `false`: Firecracker-class snapshotting
 *      is achievable but unwired, and a capability flag that says `true`
 *      while `snapshot`/`restore` only throw is a latent dispatch bug.
 *   2. Pod spec -- every pod is annotated with `runtimeClassName: kata`
 *      (or the override from `ProvisionOpts.config.runtimeClassName`).
 *
 * `snapshot` / `restore` are inherited from K8sCompute (they throw
 * `NotSupportedError`, consistent with `capabilities.snapshot === false`).
 * A follow-up PR can flip the flag and override the methods together.
 */

import type { ComputeCapabilities, ComputeKind } from "./types.js";
import { K8sCompute, type K8sComputeConfig, type K8sHandleMeta } from "./k8s.js";

/** Default Kata runtime class. Overridable via `ProvisionOpts.config.runtimeClassName`. */
export const DEFAULT_KATA_RUNTIME_CLASS = "kata";

export class KataCompute extends K8sCompute {
  readonly kind: ComputeKind = "k8s-kata";
  readonly capabilities: ComputeCapabilities = {
    snapshot: false,
    pool: true,
    networkIsolation: true,
    provisionLatency: "seconds",
    singleton: false,
    canDelete: true,
    canReboot: false,
    supportsWorktree: false,
    supportsSecretMount: true,
    needsAuth: true,
    initialStatus: "stopped",
    isolationModes: [{ value: "pod", label: "Pod" }],
  };

  protected augmentPodSpec(spec: Record<string, unknown>, cfg: K8sComputeConfig): Record<string, unknown> {
    const runtimeClassName = cfg.runtimeClassName ?? DEFAULT_KATA_RUNTIME_CLASS;
    return { ...spec, runtimeClassName };
  }

  protected buildHandleMeta(base: K8sHandleMeta, cfg: K8sComputeConfig): K8sHandleMeta {
    return { ...base, runtimeClassName: cfg.runtimeClassName ?? DEFAULT_KATA_RUNTIME_CLASS };
  }
}
