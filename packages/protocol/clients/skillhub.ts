/**
 * SkillHubClient -- wire-level client for the `skillhub/*` RPC surface.
 *
 * Distinct from `AgentClient.skill*` methods, which operate on the
 * BUILTIN agent-skill store (`app.skills` / `FileSkillStore`). The
 * two are namespaced by `skill/` vs `skillhub/` in the RPC layer and
 * by `ark skill` vs `ark skills` in the CLI. Consolidating them is
 * deferred per the post-PR followup (`project_skillhub_namespace_unification`).
 *
 * v1 surface (this commit): list, get, put, delete.
 * Deferred to subsequent commits: sync_status, get_with_ancestor,
 * search, published_after, admin/skillhub/list.
 */

import type {
  SkillhubDeleteResult,
  SkillhubGetResult,
  SkillhubGetWithAncestorParams,
  SkillhubGetWithAncestorResult,
  SkillhubListResult,
  SkillhubPutParams,
  SkillhubPutResult,
  SkillhubSkill,
  SkillhubSyncStatusLocalVersion,
  SkillhubSyncStatusResult,
} from "../../types/index.js";
import type { RpcFn } from "./rpc.js";

export class SkillHubClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  async skillhubList(): Promise<SkillhubSkill[]> {
    const { skills } = await this.rpc<SkillhubListResult>("skillhub/list");
    return skills;
  }

  async skillhubGet(id: string): Promise<SkillhubSkill> {
    const { skill } = await this.rpc<SkillhubGetResult>("skillhub/get", { id });
    return skill;
  }

  async skillhubPut(params: SkillhubPutParams): Promise<SkillhubPutResult> {
    return this.rpc<SkillhubPutResult>("skillhub/put", params as unknown as Record<string, unknown>);
  }

  async skillhubDelete(id: string): Promise<SkillhubDeleteResult> {
    return this.rpc<SkillhubDeleteResult>("skillhub/delete", { id });
  }

  async skillhubSyncStatus(local_versions: SkillhubSyncStatusLocalVersion[]): Promise<SkillhubSyncStatusResult> {
    return this.rpc<SkillhubSyncStatusResult>("skillhub/sync_status", { local_versions });
  }

  async skillhubGetWithAncestor(params: SkillhubGetWithAncestorParams): Promise<SkillhubGetWithAncestorResult> {
    return this.rpc<SkillhubGetWithAncestorResult>(
      "skillhub/get_with_ancestor",
      params as unknown as Record<string, unknown>,
    );
  }

  async skillhubSearch(query: string): Promise<SkillhubSkill[]> {
    const { skills } = await this.rpc<SkillhubListResult>("skillhub/search", { query });
    return skills;
  }

  async skillhubPublishedAfter(since: string): Promise<SkillhubSkill[]> {
    const { skills } = await this.rpc<SkillhubListResult>("skillhub/published_after", { since });
    return skills;
  }
}
