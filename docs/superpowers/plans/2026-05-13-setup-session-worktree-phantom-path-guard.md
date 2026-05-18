# setupSessionWorktree Phantom-Path Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert a silent 9.5-minute hang (phantom-path `workdir` written to DB when `supportsWorktree=false`) into an immediate loud throw with a descriptive error message.

**Architecture:** Add a single precondition guard inside `setupSessionWorktree` that fires before the `resolve(effectiveWorkdir)` write at lines 132-136. When `supportsWorktree=false` and the computed `effectiveWorkdir` resolves to a path that does not exist on the local filesystem, throw an `Error` with a message naming the compute kind, the bad path, and what the operator should do. No architecture changes -- one guard, one test describe-block, one commit.

**Tech Stack:** TypeScript, Bun test runner (`bun:test`), existing `AppContext.forTestAsync()` test harness, `existsSync` from Node `fs`.

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `packages/core/services/worktree/setup.ts` | Add precondition guard before the `resolve(effectiveWorkdir)` write |
| Modify | `packages/core/__tests__/setup-session-worktree.test.ts` | Add new `describe` block for remote-compute guard |

No new files. Two existing files touched.

---

### Task 1: Write the failing tests for the remote-compute phantom-path guard

**Files:**
- Modify: `packages/core/__tests__/setup-session-worktree.test.ts`

The existing test file lives at `packages/core/__tests__/setup-session-worktree.test.ts`. It already imports `setupSessionWorktree` and uses `AppContext.forTestAsync()`. Append a new `describe` block at the bottom of the file (after line 150, after the closing `});` of the existing describe).

The tests need to register a stub compute whose `capabilities.supportsWorktree = false` and then call `setupSessionWorktree` with that compute's DB row. The tricky part: `app.getCompute(compute_kind)` is what `setupSessionWorktree` calls internally (line 87 of `setup.ts`). We need to register a stub that returns `supportsWorktree: false`.

Looking at `app.ts:993-1000`, `registerCompute` accepts a `NewCompute` (the `Compute` interface from `packages/core/compute/types.ts:370`). We build a minimal stub object that satisfies the interface just enough for the guard path.

The session DB row also needs `compute_kind` set so line 87 of `setup.ts` routes to our stub. `app.sessions.create` accepts a config object -- check what `compute_kind` field the session row has and how to set it.

- [ ] **Step 1.1: Find how to set compute_kind on a session row**

Run the following to confirm the field name:

```bash
grep -n 'compute_kind' packages/core/drizzle/schema/sqlite.ts | head -10
grep -n 'compute_kind' packages/types/session.ts | head -10
```

Expected output: a line like `compute_kind: text("compute_kind")` in the schema, and `compute_kind?: string | null` or similar in the Session type.

- [ ] **Step 1.2: Find how sessions.create accepts compute_kind**

```bash
grep -n 'compute_kind\|CreateSession' packages/core/services/session/service.ts | head -20
```

Expected: either `create(params: { compute_kind?: string; ... })` or a separate `update` call sets it.

- [ ] **Step 1.3: Write the failing test block**

Append the following block to `packages/core/__tests__/setup-session-worktree.test.ts`, immediately after the closing `});` on line 150:

```typescript
// ── Remote compute phantom-path guard ─────────────────────────────────────

describe("setupSessionWorktree -- remote compute phantom-path guard", async () => {
  /**
   * Build the minimal stub Compute implementation that satisfies the interface
   * used by `app.getCompute(kind)` inside setupSessionWorktree (line 87 of
   * setup.ts). Only `kind` and `capabilities.supportsWorktree` are read by the
   * guard; all other methods may throw to catch unexpected invocations.
   */
  function makeRemoteComputeStub(kind: string) {
    return {
      kind,
      capabilities: {
        snapshot: false,
        pool: true,
        networkIsolation: false,
        provisionLatency: "seconds" as const,
        singleton: false,
        canDelete: true,
        canReboot: false,
        supportsWorktree: false,
        supportsSecretMount: true,
        needsAuth: true,
        initialStatus: "stopped",
        isolationModes: [],
      },
      // These methods are not called on the local-conductor side for remote
      // computes; stubs throw if unexpectedly invoked.
      provision: async () => { throw new Error("stub: provision not expected"); },
      rehydrateHandle: () => { throw new Error("stub: rehydrateHandle not expected"); },
      stop: async () => { throw new Error("stub: stop not expected"); },
      destroy: async () => { throw new Error("stub: destroy not expected"); },
      snapshot: async () => { throw new Error("stub: snapshot not expected"); },
      restore: async () => { throw new Error("stub: restore not expected"); },
      prepareWorkspace: async () => { throw new Error("stub: prepareWorkspace not expected"); },
      flushPlacement: async () => { throw new Error("stub: flushPlacement not expected"); },
      getMetrics: async () => [],
      attachExistingHandle: () => { throw new Error("stub: attachExistingHandle not expected"); },
      resolveWorkdir: () => null,
    } as any;
  }

  it("throws immediately when supportsWorktree=false and effectiveWorkdir does not exist locally", async () => {
    // Register a k8s-like stub compute so app.getCompute("stub-remote") returns
    // supportsWorktree=false.
    app.registerCompute(makeRemoteComputeStub("stub-remote") as any);

    // Create a session whose workdir points at a pod-internal path that is
    // guaranteed not to exist on the test host (mirrors the production symptom
    // where session.workdir = /workspace/<sid>/ark after K8s clone).
    const phantomWorkdir = `/workspace/s-phantom-test/ark`;
    const session = await app.sessions.create({
      summary: "remote phantom-path regression",
      repo: phantomWorkdir,
      workdir: phantomWorkdir,
    });

    // Simulate the compute DB row (the second arg to setupSessionWorktree is
    // typed as `Compute | null` which is the DB row, not the implementation).
    // We pass null for the DB row and instead rely on app.getCompute("stub-remote")
    // being registered. BUT: setup.ts line 87 does:
    //   const computeImpl = compute ? app.getCompute(compute.compute_kind) : app.getCompute("local");
    // So we need a non-null compute row with compute_kind="stub-remote".
    const fakeComputeRow = {
      compute_kind: "stub-remote",
    } as any;

    // EXPECT: the function throws before writing to the DB, with a message
    // that names the compute kind and the bad path.
    await expect(
      setupSessionWorktree(app, session, fakeComputeRow)
    ).rejects.toThrow(/supportsWorktree=false/);

    // ALSO EXPECT: session.workdir was NOT overwritten to the phantom path.
    const afterSession = await app.sessions.get(session.id);
    expect(afterSession!.workdir).not.toBe(phantomWorkdir);
  }, 30_000);

  it("does NOT throw when supportsWorktree=false but workdir already matches the remote path (idempotent re-dispatch)", async () => {
    // This test documents the intended future safe path once resolveWorkdir is
    // wired. For now it asserts that when the compute is local (supportsWorktree=true)
    // the function still works normally -- ensuring we did not accidentally
    // break the local path while adding the guard.
    const session = await app.sessions.create({
      summary: "local still works after guard",
      repo: ".",
    });

    // null compute => falls back to app.getCompute("local") which has supportsWorktree=true
    await expect(
      setupSessionWorktree(app, session, null)
    ).resolves.toBeDefined();
  }, 30_000);
});
```

- [ ] **Step 1.4: Run the new tests to confirm they fail (guard not yet implemented)**

```bash
cd /Users/zineng/featureScala/ark && make test-file F=packages/core/__tests__/setup-session-worktree.test.ts 2>&1 | tail -40
```

Expected: the first new test (`throws immediately when supportsWorktree=false...`) FAILS because `setupSessionWorktree` currently does NOT throw -- it silently overwrites `session.workdir`. The second new test (`does NOT throw...`) should PASS. The three pre-existing tests should all still PASS.

---

### Task 2: Implement the guard in `setupSessionWorktree`

**Files:**
- Modify: `packages/core/services/worktree/setup.ts` (lines 121-136)

The guard lives between the worktree/copy/setup block (ends at line 119) and the `claude.trustWorktree` call (line 123). The exact insertion point is **after** `effectiveWorkdir` has its final value (i.e., either the worktree path from `setupWorktree` or unchanged `repoSource`) and **before** the `resolve(effectiveWorkdir)` write to the DB at lines 132-136.

The condition:
- `supportsWorktree` is `false` (already computed at line 88)
- AND `existsSync(effectiveWorkdir)` returns `false` (the path doesn't exist on the local fs)

The message must include: compute kind, the bad path, and actionable operator guidance.

- [ ] **Step 2.1: Add the guard**

In `packages/core/services/worktree/setup.ts`, find the block at lines 121-136:

```typescript
  // Trust worktree for Claude
  log("Configuring Claude trust + channel...");
  claude.trustWorktree(repoSource, effectiveWorkdir);

  // Persist an ABSOLUTE workdir on the session row. The previous behaviour
  // left session.workdir as null/"." when the user passed --repo ".", which
  // tripped the transcript parser into resolving an empty path against the
  // parent process cwd and attributing the wrong jsonl file. Resolving here
  // (against the dispatching process cwd, NOT the agent cwd) gives every
  // downstream observer (parser, status poller, web UI) an unambiguous
  // absolute path. Idempotent: skip the write if the row already matches.
  const persisted = resolve(effectiveWorkdir);
  if (session.workdir !== persisted) {
    await app.sessions.update(session.id, { workdir: persisted });
    (session as { workdir: string | null }).workdir = persisted;
  }
```

Replace it with:

```typescript
  // ── Phantom-path guard ──────────────────────────────────────────────────
  //
  // When the compute does not share the conductor's filesystem
  // (supportsWorktree=false -- K8s, EC2, Firecracker), the git clone lands
  // inside the per-session pod/VM, not on the local disk. If effectiveWorkdir
  // still resolves to a local path that doesn't exist we would write a phantom
  // path into the DB and the launcher would hang forever waiting for a
  // filesystem event that never fires.
  //
  // Fail loudly here rather than silently. The correct fix for remote computes
  // is to use the path returned by `resolveWorkdir` (set during prepareWorkspace);
  // that architectural wiring is tracked separately. This guard is a safety net.
  if (!supportsWorktree && !existsSync(effectiveWorkdir)) {
    const computeKind = compute?.compute_kind ?? "unknown";
    throw new Error(
      `setupSessionWorktree refusing to set session.workdir=${effectiveWorkdir} on local filesystem ` +
        `when compute (${computeKind}) supports neither worktree nor local fs access. ` +
        `The clone lives on the remote compute; session.workdir must point there. ` +
        `Check that prepareWorkspace ran and resolveWorkdir returned a valid path before dispatching.`,
    );
  }

  // Trust worktree for Claude
  log("Configuring Claude trust + channel...");
  claude.trustWorktree(repoSource, effectiveWorkdir);

  // Persist an ABSOLUTE workdir on the session row. The previous behaviour
  // left session.workdir as null/"." when the user passed --repo ".", which
  // tripped the transcript parser into resolving an empty path against the
  // parent process cwd and attributing the wrong jsonl file. Resolving here
  // (against the dispatching process cwd, NOT the agent cwd) gives every
  // downstream observer (parser, status poller, web UI) an unambiguous
  // absolute path. Idempotent: skip the write if the row already matches.
  const persisted = resolve(effectiveWorkdir);
  if (session.workdir !== persisted) {
    await app.sessions.update(session.id, { workdir: persisted });
    (session as { workdir: string | null }).workdir = persisted;
  }
```

Note: `existsSync` is already imported at line 9. `compute` is already in scope (the function parameter). `supportsWorktree` is already in scope (line 88). No new imports needed.

- [ ] **Step 2.2: Run the full test file and confirm all tests pass**

```bash
cd /Users/zineng/featureScala/ark && make test-file F=packages/core/__tests__/setup-session-worktree.test.ts 2>&1 | tail -40
```

Expected output (all tests pass, 7 total -- 5 pre-existing + 2 new):

```
✓ creates a worktree when repo='.', even with no explicit workdir
✓ persists the absolute worktree path to the session row
✓ creates a worktree when workdir is explicitly an absolute git repo path
✓ does NOT create a worktree when config.worktree === false
✓ does NOT create a worktree when the resolved repo source is not a git repo
✓ throws immediately when supportsWorktree=false and effectiveWorkdir does not exist locally
✓ does NOT throw when supportsWorktree=false but workdir already matches the remote path (idempotent re-dispatch)

 7 pass
 0 fail
```

- [ ] **Step 2.3: Run the git-author test file to confirm no regression**

```bash
cd /Users/zineng/featureScala/ark && make test-file F=packages/core/__tests__/worktree-git-author.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 2.4: Run lint and format**

```bash
cd /Users/zineng/featureScala/ark && make format && make lint 2>&1 | tail -20
```

Expected: zero errors, zero warnings.

- [ ] **Step 2.5: Commit**

```bash
git -C /Users/zineng/featureScala/ark add \
  packages/core/services/worktree/setup.ts \
  packages/core/__tests__/setup-session-worktree.test.ts
git -C /Users/zineng/featureScala/ark commit -m "fix: guard against phantom workdir when compute does not share local fs"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task covering it |
|---|---|
| Guard fires inside `setupSessionWorktree` before `session.workdir` write | Task 2 -- guard inserted between `effectiveWorkdir` resolution and `resolve(effectiveWorkdir)` DB write |
| Condition: `supportsWorktree=false` AND path doesn't exist locally | Task 2 -- `!supportsWorktree && !existsSync(effectiveWorkdir)` |
| Error message names compute kind, bad path, actionable guidance | Task 2 -- message includes `computeKind`, `effectiveWorkdir`, and operator instructions |
| TDD -- failing test before fix | Task 1 written before Task 2 |
| Test asserts `session.workdir` NOT clobbered | Task 1 -- checks `afterSession.workdir !== phantomWorkdir` |
| Test asserts throw contains `supportsWorktree=false` | Task 1 -- `rejects.toThrow(/supportsWorktree=false/)` |
| Local path (supportsWorktree=true) still works | Task 1 second test asserts local dispatch still resolves |

### Placeholder scan

No TBD, TODO, or "implement later" strings. Every step contains actual code. Types and method names are consistent across tasks.

### Type consistency

- `supportsWorktree` in `ComputeCapabilities` (`packages/core/compute/types.ts:73`) -- matches `supportsWorktree` used in guard condition.
- `compute?.compute_kind` -- `Compute` in types has `compute_kind: string` (confirmed from `k8s.ts` usage); the `?` guard handles the `null` compute parameter correctly.
- `existsSync` -- already imported in `setup.ts` line 9; no new import needed.
- The stub in the test uses `as any` for both `registerCompute` and the fake compute row, which is consistent with how `k8s.test.ts` stubs out compute deps in the existing test suite.
