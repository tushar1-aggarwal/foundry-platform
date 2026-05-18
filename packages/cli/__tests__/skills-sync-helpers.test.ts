/**
 * Unit tests for the pure helpers extracted from the sync orchestrator
 * (planSweep, unresolvedPaths). The orchestrator itself is integration-
 * tested in C15 with mocked transport + filesystem; these helpers carry
 * the two pieces of correctness logic that bit reviewers in C14's
 * pre-commit review: stale-file sweep on FF-pull, and "refuse to push
 * when files are unresolved" on merge-accept.
 */

import { describe, expect, it } from "bun:test";
import { planSweep, unresolvedPaths } from "../commands/skills-sync.js";

describe("planSweep — stale-file deletion plan", () => {
  it("returns paths in existing-but-not-wanted", () => {
    const existing = ["SKILL.md", "refs/spec.md", "refs/old-doc.md", "scripts/run.py"];
    const wanted = ["SKILL.md", "refs/spec.md"];
    expect(planSweep(existing, wanted)).toEqual(["refs/old-doc.md", "scripts/run.py"]);
  });

  it("returns empty when every existing file is wanted", () => {
    expect(planSweep(["a", "b"], ["a", "b", "c"])).toEqual([]);
  });

  it("returns empty when both sets are empty", () => {
    expect(planSweep([], [])).toEqual([]);
  });

  it("sorts output for deterministic logging / testing", () => {
    expect(planSweep(["z", "a", "m"], [])).toEqual(["a", "m", "z"]);
  });

  it("does NOT return wanted-but-not-existing (sweep is delete-only)", () => {
    // planSweep returns paths to delete. Files in `wanted` but not in
    // `existing` are about to be written, not deleted; they don't
    // appear in the sweep plan.
    expect(planSweep(["a"], ["a", "b"])).toEqual([]);
  });
});

describe("unresolvedPaths — refuse-push guard input", () => {
  it("collects paths where merged === false", () => {
    const results = [
      { path: "SKILL.md", merged: true },
      { path: "refs/spec.md", merged: true },
      { path: "scripts/run.py", merged: false },
      { path: "scripts/dangerous.py", merged: false },
    ];
    expect(unresolvedPaths(results)).toEqual(["scripts/run.py", "scripts/dangerous.py"]);
  });

  it("returns empty when every file merged", () => {
    expect(
      unresolvedPaths([
        { path: "a", merged: true },
        { path: "b", merged: true },
      ]),
    ).toEqual([]);
  });

  it("returns empty when the list is empty", () => {
    expect(unresolvedPaths([])).toEqual([]);
  });
});
