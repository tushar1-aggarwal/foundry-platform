/**
 * Compute layer -- public API.
 *
 * The `Compute` + `Isolation` two-axis abstraction (composed via
 * `ComputeTarget`), the concrete impls (Local / EC2 / K8s x Direct /
 * Docker / Devcontainer / DockerCompose / Worktree), snapshot
 * persistence, port discovery, and a couple of shared helpers. See
 * `docs/architecture.md`.
 */

// ── Compute + Isolation split ──────────────────────────────────────────────

export type {
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  Isolation,
  IsolationKind,
  AgentHandle,
  ProvisionLatency,
  PrepareCtx,
  ProvisionOpts,
  LaunchOpts,
  Snapshot,
  ComputeSnapshot,
  AttachExistingComputeRow,
  EnsureReachableOpts,
  PrepareWorkspaceOpts,
  FlushPlacementOpts,
} from "./types.js";
export { NotSupportedError } from "./types.js";

// ── Computes ───────────────────────────────────────────────────────────────

export { LocalCompute } from "./local.js";
export { EC2Compute } from "./ec2/compute.js";
export type { EC2HandleMeta, EC2ProvisionConfig, EC2ComputeHelpers } from "./ec2/compute.js";
export { K8sCompute } from "./k8s.js";
export type { K8sComputeConfig, K8sHandleMeta, K8sComputeDeps } from "./k8s.js";

// ── Isolations ─────────────────────────────────────────────────────────────

export { DirectIsolation } from "./isolation/direct.js";
export { DockerIsolation } from "./isolation/docker.js";
export { DevcontainerIsolation } from "./isolation/devcontainer.js";
export { DockerComposeIsolation } from "./isolation/docker-compose.js";
export { WorktreeIsolation } from "./isolation/worktree.js";
export type { DockerIsolationConfig } from "./isolation/docker-config.js";

// ── Composer ───────────────────────────────────────────────────────────────

export { ComputeTarget } from "./compute-target.js";

// ── Snapshot persistence ───────────────────────────────────────────────────

export type { SnapshotStore, SnapshotRef, SnapshotBlob, SnapshotListFilter } from "./snapshot-store.js";
export { SnapshotNotFoundError } from "./snapshot-store.js";
export { FsSnapshotStore } from "./snapshot-store-fs.js";

// ── Port discovery ─────────────────────────────────────────────────────────

export { discoverWorkspacePorts, type PortDecl } from "./isolation/ports.js";
export { discoverDevcontainerPorts } from "./isolation/devcontainer.js";
export { discoverComposePorts, findComposeFile } from "./isolation/docker-compose.js";

// ── Shared helpers ─────────────────────────────────────────────────────────

export { cloneWorkspaceViaArkd } from "./workspace-clone.js";
export { attachComputeMethods, buildAgentHandle } from "./handle-helpers.js";
