import { describe, it, expect } from "bun:test";
import { getAncestorChain, TeamChainError, type TeamParentLookup } from "../team-chain.js";

function makeRepo(parents: Record<string, string | null | undefined>): TeamParentLookup {
  return {
    async getParentTeamId(teamId: string) {
      return Object.prototype.hasOwnProperty.call(parents, teamId) ? parents[teamId] : undefined;
    },
  };
}

describe("getAncestorChain", () => {
  it("returns full chain for a 3-level tree", async () => {
    const repo = makeRepo({ team: "parent", parent: "grand", grand: null });
    const chain = await getAncestorChain(repo, "team");
    expect(chain).toEqual(["team", "parent", "grand"]);
  });

  it("returns single-element chain for a top-of-tenant team", async () => {
    const repo = makeRepo({ team: null });
    const chain = await getAncestorChain(repo, "team");
    expect(chain).toEqual(["team"]);
  });

  it("stops at a soft-deleted (missing) ancestor", async () => {
    const repo = makeRepo({ team: "parent", parent: "deleted-grand" });
    const chain = await getAncestorChain(repo, "team");
    expect(chain).toEqual(["team", "parent"]);
  });

  it("throws TeamChainError(cycle) on a 2-team A->B->A cycle", async () => {
    const repo = makeRepo({ A: "B", B: "A" });
    let caught: TeamChainError | null = null;
    try {
      await getAncestorChain(repo, "A");
    } catch (e) {
      caught = e as TeamChainError;
    }
    expect(caught).toBeInstanceOf(TeamChainError);
    expect(caught!.kind).toBe("cycle");
    expect(caught!.atTeamId).toBe("A");
  });

  it("throws TeamChainError(depth-cap) on a chain longer than the cap", async () => {
    const parents: Record<string, string | null> = {};
    for (let i = 0; i < 10; i++) parents[`t${i}`] = `t${i + 1}`;
    parents["t10"] = null;
    const repo = makeRepo(parents);

    let caught: TeamChainError | null = null;
    try {
      await getAncestorChain(repo, "t0");
    } catch (e) {
      caught = e as TeamChainError;
    }
    expect(caught).toBeInstanceOf(TeamChainError);
    expect(caught!.kind).toBe("depth-cap");
    expect(caught!.atTeamId).toBe("t8");
  });

  it("respects a custom depthCap", async () => {
    const repo = makeRepo({ a: "b", b: "c", c: null });
    const chain = await getAncestorChain(repo, "a", { depthCap: 3 });
    expect(chain).toEqual(["a", "b", "c"]);

    let caught: TeamChainError | null = null;
    try {
      await getAncestorChain(repo, "a", { depthCap: 2 });
    } catch (e) {
      caught = e as TeamChainError;
    }
    expect(caught).toBeInstanceOf(TeamChainError);
    expect(caught!.kind).toBe("depth-cap");
    expect(caught!.atTeamId).toBe("c");
  });

  it("returns empty chain when the input team itself is missing", async () => {
    const repo = makeRepo({});
    const chain = await getAncestorChain(repo, "missing");
    expect(chain).toEqual([]);
  });
});
