# Docs Flow E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the docs-flow e2e tests covering both Ark deployment modes (local + hosted) per `docs/superpowers/specs/2026-05-12-docs-flow-e2e-design.md`. 4 test cases total, real git clone + push + create_pr action, fake claude binary, local auth-required git server.

**Architecture:** Two test files, one per mode. They call a shared compound + restart-fail body via RPC, so the assertions are identical between modes. Boot differs: local mode spawns `ark server start` directly; hosted mode spawns `ark server start --hosted` against a docker compose stack with Temporal + Postgres + sidecar isolation.

**Tech Stack:** Bun runtime, `bun:test`, git's standard `git-http-backend` CGI binary, `Bun.serve` for the auth wrapper, `Bun.spawn` for git/server invocations, Drizzle-managed Postgres + Redis (hosted), SQLite (local).

**Constraint:** No assertion relaxation. If a test fails, fix product code or helpers. If an assertion is wrong, return to spec amendment.

---

## File Structure

| File | Owner | Responsibility |
|---|---|---|
| `e2e/fixtures/flows/e2e-docs-review.yaml` | NEW | Test flow: plan → implement → review_gate → pr |
| `e2e/fixtures/fake-claude.sh` | NEW | Fake claude binary: per-stage logic, commits on implement, POSTs CompletionReport |
| `e2e/helpers/git-http-server.ts` | NEW | Bun.serve + git-http-backend with basic auth |
| `e2e/helpers/docs-flow-spec.ts` | NEW | Shared compound + restart-fail test bodies (RPC-only, mode-agnostic) |
| `e2e/local-bespoke.test.ts` | NEW | Boots local-mode server; invokes shared bodies |
| `e2e/fixtures/agents/stub-planner.yaml` | MODIFY | Change `runtime: stub-runner` → `runtime: claude-code` |
| `e2e/fixtures/agents/stub-implementer.yaml` | MODIFY | Same change |
| `e2e/helpers/server-process.ts` | MODIFY | Add `startLocalServer()` |
| `e2e/temporal-control-plane.test.ts` | MODIFY | Replace 8 tests with 2 (compound + restart-fail) using shared bodies |
| `.infra/docker-compose.e2e.yaml` | MODIFY | Bind-mount fake-claude.sh into sidecar at `/usr/local/bin/claude` |
| `Makefile` | MODIFY | Add `test-e2e-local-bespoke` target |
| `e2e/control-plane.test.ts` | DELETE | Hosted+bespoke isn't real prod |
| `e2e/fixtures/stub-runner-executor.mjs` | DELETE | Replaced by real claude-code executor |
| `e2e/fixtures/stub-agent.sh` | DELETE | Replaced by fake-claude.sh |
| `e2e/fixtures/flows/e2e-review.yaml` | DELETE | Subsumed by e2e-docs-review |
| `flows/definitions/e2e-docs.yaml` | DELETE | Only used by deleted test |
| `flows/definitions/e2e-noop.yaml` | DELETE | Only used by deleted test |
| `e2e/fixtures/agents/stub-closer.yaml` | AUDIT | Delete if orphaned after other deletes |

---

## Task 1: Add the e2e-docs-review test flow YAML

**Files:**
- Create: `e2e/fixtures/flows/e2e-docs-review.yaml`

- [ ] **Step 1: Write the flow YAML**

```yaml
# e2e/fixtures/flows/e2e-docs-review.yaml
name: e2e-docs-review
description: "Combined docs + review test flow: plan -> implement -> review_gate -> pr.
              requires_repo: true exercises the workspace prepare + clone + push paths
              against a local git-http-backend server with basic auth. The create_pr
              action runs through the graceful (non-GitHub) host path."
requires_repo: true
stages:
  - name: plan
    agent: stub-planner
    gate: auto
  - name: implement
    agent: stub-implementer
    gate: auto
    depends_on: [plan]
  - name: review
    type: review_gate
    gate: manual
    depends_on: [implement]
  - name: pr
    action: create_pr
    gate: auto
    depends_on: [review]
```

- [ ] **Step 2: Validate YAML parses**

Run: `bun -e "import('yaml').then(y => console.log(y.default.parse(require('fs').readFileSync('e2e/fixtures/flows/e2e-docs-review.yaml','utf8')).name))"`
Expected stdout: `e2e-docs-review`

- [ ] **Step 3: Commit**

```bash
git add e2e/fixtures/flows/e2e-docs-review.yaml
git commit -m "chore: add e2e-docs-review fixture flow (plan -> implement -> review_gate -> pr)"
```

---

## Task 2: Add fake-claude.sh

**Files:**
- Create: `e2e/fixtures/fake-claude.sh`

- [ ] **Step 1: Write the fake binary script**

```bash
#!/usr/bin/env bash
# e2e/fixtures/fake-claude.sh
#
# Stand-in for the real `claude` binary in e2e tests. Invoked through the
# real claude-code executor; replaces only the LLM-call body. Posts a
# CompletionReport to the conductor's channel HTTP endpoint and exits.
#
# Env contract (set by ark before invoking the binary):
#   ARK_SESSION_ID   -- required
#   ARK_STAGE        -- required
#   ARK_CONDUCTOR_URL or ARK_CONDUCTOR_PORT
#   ARK_WORKDIR      -- cwd of the agent (the cloned repo)
#   ARK_DIR          -- ark data dir (used for env-log file)
#   ARK_FAKE_CLAUDE_FAIL_STAGE -- optional: when set and equals ARK_STAGE,
#                                 emits an error report instead of success.

set -euo pipefail

SESSION_ID="${ARK_SESSION_ID:?ARK_SESSION_ID is required}"
STAGE="${ARK_STAGE:?ARK_STAGE is required}"
WORKDIR="${ARK_WORKDIR:-}"
ARK_DIR_VAL="${ARK_DIR:-/tmp}"

# Conductor URL fallback chain
if [[ -n "${ARK_CONDUCTOR_URL:-}" ]]; then
  CONDUCTOR_URL="${ARK_CONDUCTOR_URL}"
else
  PORT="${ARK_CONDUCTOR_PORT:-19102}"
  CONDUCTOR_URL="http://localhost:${PORT}"
fi

# 1. Log received env for credential-resolution debugging.
mkdir -p "${ARK_DIR_VAL}/agent-envs"
printenv > "${ARK_DIR_VAL}/agent-envs/${STAGE}.log"

# 2. Failure-injection: emit AuthError CompletionReport and exit 0.
if [[ "${ARK_FAKE_CLAUDE_FAIL_STAGE:-}" == "${STAGE}" ]]; then
  curl -fsS -X POST "${CONDUCTOR_URL}/api/channel/${SESSION_ID}" \
    -H "Content-Type: application/json" \
    -d '{"ok": false, "error": {"type":"AuthError","message":"401 Unauthorized"}}' \
    || true
  exit 0
fi

# 3. On implement stage, make a real commit so create_pr has something to push.
if [[ "${STAGE}" == "implement" ]] && [[ -n "${WORKDIR}" ]] && [[ -d "${WORKDIR}/.git" ]]; then
  cd "${WORKDIR}"
  echo "stub commit at $(date -u +%FT%TZ)" >> NOTES.md
  git -c user.email=stub@ark.local -c user.name=stub-implementer add NOTES.md
  git -c user.email=stub@ark.local -c user.name=stub-implementer commit -m "stub-implementer: ${SESSION_ID}"
fi

# 4. Success report.
curl -fsS -X POST "${CONDUCTOR_URL}/api/channel/${SESSION_ID}" \
  -H "Content-Type: application/json" \
  -d "{\"ok\": true, \"summary\": \"stub completed ${STAGE} stage\"}"
```

- [ ] **Step 2: Make executable + verify syntax**

```bash
chmod +x e2e/fixtures/fake-claude.sh
bash -n e2e/fixtures/fake-claude.sh
```

Expected: exit 0 (no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add e2e/fixtures/fake-claude.sh
git commit -m "feature: add fake-claude.sh stand-in binary for e2e tests"
```

---

## Task 3: Update stub agent YAMLs to use claude-code runtime

**Files:**
- Modify: `e2e/fixtures/agents/stub-planner.yaml`
- Modify: `e2e/fixtures/agents/stub-implementer.yaml`

- [ ] **Step 1: Read current planner YAML**

Run: `cat e2e/fixtures/agents/stub-planner.yaml`
Note the current content. Expected: `runtime: stub-runner`.

- [ ] **Step 2: Update stub-planner**

```yaml
# e2e/fixtures/agents/stub-planner.yaml
name: stub-planner
description: "E2E stub agent for the plan stage. Uses the real claude-code executor
              with fake-claude.sh as the binary, so dispatch chain + workspace
              prepare + credential resolution all run for real."
runtime: claude-code
model: stub
max_turns: 1
system_prompt: "stub"
tools: []
mcp_servers: []
skills: []
memories: []
context: []
permission_mode: bypassPermissions
env: {}
```

- [ ] **Step 3: Update stub-implementer (read existing first)**

Run: `cat e2e/fixtures/agents/stub-implementer.yaml`

Then write:

```yaml
# e2e/fixtures/agents/stub-implementer.yaml
name: stub-implementer
description: "E2E stub agent for the implement stage. Uses the real claude-code
              executor with fake-claude.sh as the binary; the binary makes a real
              git commit so the pr stage's create_pr action has something to push."
runtime: claude-code
model: stub
max_turns: 1
system_prompt: "stub"
tools: []
mcp_servers: []
skills: []
memories: []
context: []
permission_mode: bypassPermissions
env: {}
```

- [ ] **Step 4: Commit**

```bash
git add e2e/fixtures/agents/stub-planner.yaml e2e/fixtures/agents/stub-implementer.yaml
git commit -m "feature: switch stub agents to runtime: claude-code (real executor + fake binary)"
```

---

## Task 4: Write git-http-server helper — first the smoke test

**Files:**
- Test: `e2e/helpers/__tests__/git-http-server.test.ts`

- [ ] **Step 1: Write the smoke test**

```typescript
// e2e/helpers/__tests__/git-http-server.test.ts
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";

import { startGitHttpServer } from "../git-http-server.js";

const TOKEN = "test-fake-token-XYZ";

function initBareRepoWithSeed(): string {
  const tmp = mkdtempSync(join(tmpdir(), "ark-git-server-test-"));
  const bare = join(tmp, "fake-bitbucket.git");
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  // Seed an initial commit on main via a temporary working clone.
  const working = join(tmp, "working");
  execFileSync("git", ["clone", bare, working]);
  execFileSync("bash", ["-c", "echo initial > README.md"], { cwd: working });
  execFileSync("git", ["-C", working, "-c", "user.email=test@x", "-c", "user.name=test", "add", "README.md"]);
  execFileSync("git", ["-C", working, "-c", "user.email=test@x", "-c", "user.name=test", "commit", "-m", "initial"]);
  execFileSync("git", ["-C", working, "push", "origin", "main"]);
  return bare;
}

describe("git-http-server", () => {
  let cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const c = cleanups.pop()!;
      try { await c(); } catch {}
    }
  });

  test("rejects requests without Authorization header", async () => {
    const repoPath = initBareRepoWithSeed();
    cleanups.push(() => rmSync(join(repoPath, ".."), { recursive: true, force: true }));

    const server = await startGitHttpServer({ repoPath, expectedToken: TOKEN });
    cleanups.push(() => server.kill());

    const r = await fetch(`${server.url}/info/refs?service=git-upload-pack`);
    expect(r.status).toBe(401);
  });

  test("accepts requests with the correct basic-auth token and serves git protocol", async () => {
    const repoPath = initBareRepoWithSeed();
    const cloneTmp = mkdtempSync(join(tmpdir(), "ark-git-clone-"));
    cleanups.push(() => rmSync(join(repoPath, ".."), { recursive: true, force: true }));
    cleanups.push(() => rmSync(cloneTmp, { recursive: true, force: true }));

    const server = await startGitHttpServer({ repoPath, expectedToken: TOKEN });
    cleanups.push(() => server.kill());

    // Encode user:token into git URL form (https://user:token@host:port/...)
    const url = new URL(server.url);
    const authedUrl = `${url.protocol}//user:${TOKEN}@${url.host}${url.pathname}`;

    const target = join(cloneTmp, "clone");
    execFileSync("git", ["clone", authedUrl, target]);

    // Verify clone contents
    const log = execFileSync("git", ["-C", target, "log", "--oneline"]).toString();
    expect(log).toContain("initial");
  });

  test("rejects requests with the wrong token", async () => {
    const repoPath = initBareRepoWithSeed();
    cleanups.push(() => rmSync(join(repoPath, ".."), { recursive: true, force: true }));

    const server = await startGitHttpServer({ repoPath, expectedToken: TOKEN });
    cleanups.push(() => server.kill());

    const wrong = Buffer.from(`user:wrong-token`).toString("base64");
    const r = await fetch(`${server.url}/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Basic ${wrong}` },
    });
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (file does not exist yet)**

Run: `bun test e2e/helpers/__tests__/git-http-server.test.ts`
Expected: FAIL with module-resolution error on `../git-http-server.js`

- [ ] **Step 3: Implement `e2e/helpers/git-http-server.ts`**

Create: `e2e/helpers/git-http-server.ts`

```typescript
/**
 * Fake remote git server for e2e tests.
 *
 * Wraps the standard `git-http-backend` CGI binary (ships with git) behind a
 * Bun HTTP layer that enforces basic-auth. Used by the docs-flow e2e tests to
 * simulate a Bitbucket-shaped HTTP remote that requires a token, without any
 * real Bitbucket/GitHub connectivity.
 *
 *   ┌──────────────┐    HTTP req    ┌──────────────┐    CGI       ┌──────────────┐
 *   │ ark git ops  │ ─────────────► │ Bun.serve    │ ───────────► │ git-http-    │
 *   │ (clone/push) │  Auth: Basic   │ (this file)  │  env+stdin   │ backend      │
 *   │              │ ◄───────────── │ validates    │ ◄─────────── │ (git binary) │
 *   └──────────────┘    response    └──────────────┘  stdout      └──────────────┘
 *                                          │
 *                                          ▼ log
 *                                   $ARK_DIR/git-auth-log.txt
 *
 * Authentication contract: only `Authorization: Basic <b64 of "user:<expectedToken>">`
 * is accepted. Anything else returns 401. Successful clones/pushes thus prove
 * that the right secret was selected by ark's credential resolution path.
 */

import { spawn } from "child_process";
import { appendFileSync, existsSync } from "fs";

export interface GitHttpServerOpts {
  /** Path to a bare git repo on disk (created by the caller). */
  repoPath: string;
  /** Token that the Authorization: Basic header's password part must equal. */
  expectedToken: string;
  /** Optional: append every Authorization header to this file (debug aid). */
  logFile?: string;
  /** Bind address. Use 127.0.0.1 for local mode; 0.0.0.0 to be reachable from
   *  a docker sidecar via host.docker.internal in hosted mode. */
  bindAddr?: string;
}

export interface GitHttpServerHandle {
  /** Full URL including /repo.git path component. Pass this to `session/start`. */
  url: string;
  port: number;
  kill: () => Promise<void>;
}

/**
 * Resolve the path of git-http-backend. Falls back to `git --exec-path` discovery
 * because some distros don't put it on $PATH.
 */
function resolveGitHttpBackend(): string {
  if (!existsSync("/dev/null")) throw new Error("unreachable"); // satisfies linter
  const execPath = require("child_process").execFileSync("git", ["--exec-path"]).toString().trim();
  const candidate = `${execPath}/git-http-backend`;
  if (!existsSync(candidate)) {
    throw new Error(`git-http-backend not found at ${candidate}. Ensure git is installed with HTTP support.`);
  }
  return candidate;
}

export async function startGitHttpServer(opts: GitHttpServerOpts): Promise<GitHttpServerHandle> {
  const backend = resolveGitHttpBackend();
  const expected = `Basic ${Buffer.from(`user:${opts.expectedToken}`).toString("base64")}`;
  const bind = opts.bindAddr ?? "127.0.0.1";

  // Mount repo at /repo.git
  // Strip /repo.git prefix to get PATH_INFO for the CGI; e.g., a request to
  // /repo.git/info/refs?service=git-upload-pack becomes PATH_INFO=/repo.git/info/refs
  // (git-http-backend expects the repo segment to be part of PATH_INFO and
  // GIT_PROJECT_ROOT to be the parent dir).
  const parentDir = opts.repoPath.replace(/\/[^/]+$/, "");
  const repoBasename = opts.repoPath.split("/").pop()!; // e.g. "fake-bitbucket.git"

  const server = Bun.serve({
    hostname: bind,
    port: 0, // random
    async fetch(req: Request) {
      const auth = req.headers.get("authorization") ?? "";

      if (opts.logFile) {
        try {
          appendFileSync(opts.logFile, `${new Date().toISOString()} ${req.method} ${new URL(req.url).pathname} auth=${auth}\n`);
        } catch { /* best-effort */ }
      }

      if (auth !== expected) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="git"' },
        });
      }

      // Rewrite PATH_INFO so git-http-backend finds the repo under GIT_PROJECT_ROOT.
      // Incoming URL: /repo.git/<rest>  →  PATH_INFO = /<repoBasename>/<rest>
      const url = new URL(req.url);
      const incomingPath = url.pathname;
      const rest = incomingPath.startsWith("/repo.git") ? incomingPath.slice("/repo.git".length) : incomingPath;
      const pathInfo = `/${repoBasename}${rest}`;

      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        GIT_PROJECT_ROOT: parentDir,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: pathInfo,
        REQUEST_METHOD: req.method,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers.get("content-type") ?? "",
        CONTENT_LENGTH: req.headers.get("content-length") ?? "",
        REMOTE_USER: "user",
      };

      const cgi = spawn(backend, [], { env });

      // Pipe request body to CGI stdin
      if (req.body) {
        const reader = req.body.getReader();
        const writer = cgi.stdin!;
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await new Promise<void>((resolve, reject) => {
              writer.write(value, (err) => (err ? reject(err) : resolve()));
            });
          }
          writer.end();
        };
        pump().catch(() => writer.end());
      } else {
        cgi.stdin!.end();
      }

      // Read CGI output. The CGI prints headers then a blank line then body.
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      cgi.stdout!.on("data", (c) => chunks.push(c));
      cgi.stderr!.on("data", (c) => errChunks.push(c));
      const exitCode: number = await new Promise((resolve) => cgi.on("exit", (code) => resolve(code ?? 0)));

      if (exitCode !== 0) {
        return new Response(`git-http-backend failed: ${Buffer.concat(errChunks).toString()}`, { status: 500 });
      }

      const buf = Buffer.concat(chunks);
      // Split headers from body at the first \r\n\r\n (or \n\n).
      let sepIdx = buf.indexOf("\r\n\r\n");
      let sepLen = 4;
      if (sepIdx === -1) {
        sepIdx = buf.indexOf("\n\n");
        sepLen = 2;
      }
      if (sepIdx === -1) {
        return new Response(buf, { status: 200 });
      }
      const headerBlob = buf.subarray(0, sepIdx).toString("utf-8");
      const body = buf.subarray(sepIdx + sepLen);

      const headers = new Headers();
      let status = 200;
      for (const line of headerBlob.split(/\r?\n/)) {
        if (!line) continue;
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (!m) continue;
        const [, name, value] = m;
        if (name.toLowerCase() === "status") {
          const code = parseInt(value.split(" ")[0], 10);
          if (!isNaN(code)) status = code;
        } else {
          headers.set(name, value);
        }
      }

      return new Response(body, { status, headers });
    },
  });

  const port = server.port;
  const url = `http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${port}/repo.git`;

  return {
    url,
    port,
    kill: async () => {
      server.stop(true);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test e2e/helpers/__tests__/git-http-server.test.ts`
Expected: PASS, 3 of 3 tests green

- [ ] **Step 5: Commit**

```bash
git add e2e/helpers/git-http-server.ts e2e/helpers/__tests__/git-http-server.test.ts
git commit -m "feature: add git-http-server e2e helper (git-http-backend + basic auth)"
```

---

## Task 5: Add startLocalServer to server-process.ts

**Files:**
- Modify: `e2e/helpers/server-process.ts`

- [ ] **Step 1: Read existing helper to understand pattern**

Run: `cat e2e/helpers/server-process.ts`

Note the existing exported function (likely `startHostedServer` or `spawnHosted`). Keep its signature; mirror it for local mode.

- [ ] **Step 2: Append the startLocalServer export**

Append to `e2e/helpers/server-process.ts`:

```typescript
// ──────────────────────────────────────────────────────────────────────────
// LOCAL MODE BOOT
// ──────────────────────────────────────────────────────────────────────────

export interface LocalSpawnOptions {
  /** Absolute path to a temp arkDir. */
  arkDir: string;
  /** Optional: directory to prepend to PATH (for fake-claude.sh override). */
  pathPrefix?: string;
  /** Optional: extra env. Set ARK_FAKE_CLAUDE_FAIL_STAGE here for failure test. */
  extraEnv?: Record<string, string>;
  /** Web/API port. Default 8420. */
  webPort?: number;
}

/**
 * Spawn `ark server start` (default profile, no --hosted) and wait for
 * /api/health + a session/list RPC to succeed. Returns a handle the caller
 * uses to send RPC and to kill the subprocess.
 *
 * Local mode runs on SQLite + file blob store; no Docker needed.
 */
export async function startLocalServer(opts: LocalSpawnOptions): Promise<ServerHandle> {
  const webPort = opts.webPort ?? 8420;
  await clearStalePorts([webPort]);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ARK_PROFILE: "local",
    ARK_DIR: opts.arkDir,
    ARK_AUTH_REQUIRE_TOKEN: "false",
    ARK_DEV_FORCE_DIRECT: "1",
    ARK_WEB_PORT: String(webPort),
    ...(opts.extraEnv ?? {}),
  };

  if (opts.pathPrefix) {
    env.PATH = `${opts.pathPrefix}:${process.env.PATH ?? ""}`;
  }

  const proc = Bun.spawn(["bun", "packages/cli/index.ts", "server", "start"], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });

  const webUrl = `http://localhost:${webPort}`;

  // Poll /api/health, then a real RPC, to ensure migrations are done.
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${webUrl}/api/health`);
      if (r.status === 200) { healthy = true; break; }
    } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  if (!healthy) {
    proc.kill();
    throw new Error(`startLocalServer: /api/health never returned 200 within 30s`);
  }

  // Verify session/list RPC works (proves migrations completed).
  const rpcDeadline = Date.now() + 30_000;
  let rpcOk = false;
  while (Date.now() < rpcDeadline) {
    try {
      const r = await fetch(`${webUrl}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "boot", method: "session/list", params: {} }),
      });
      const json = await r.json() as { error?: unknown; result?: unknown };
      if (!json.error) { rpcOk = true; break; }
    } catch { /* migrations still running */ }
    await Bun.sleep(200);
  }
  if (!rpcOk) {
    proc.kill();
    throw new Error(`startLocalServer: session/list RPC never succeeded within 30s`);
  }

  return { proc, webUrl };
}
```

- [ ] **Step 3: Type-check**

Run: `bun run tsc --noEmit 2>&1 | grep "server-process.ts" | head -5`
Expected: no errors specific to this file (pre-existing errors in unrelated files are OK)

- [ ] **Step 4: Commit**

```bash
git add e2e/helpers/server-process.ts
git commit -m "feature: add startLocalServer helper (no Docker, single-tenant, port 8420)"
```

---

## Task 6: Write the shared docs-flow-spec helper

**Files:**
- Create: `e2e/helpers/docs-flow-spec.ts`

- [ ] **Step 1: Write the shared spec module**

```typescript
// e2e/helpers/docs-flow-spec.ts
/**
 * Shared test bodies for the docs-flow e2e tests. Mode-agnostic: drives the
 * server entirely via the HTTP RPC client, so both local and hosted modes
 * call the same assertions.
 *
 * See docs/superpowers/specs/2026-05-12-docs-flow-e2e-design.md for the full
 * spec including assertion rationale.
 */

import { expect } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import type { RpcClient } from "./rpc-client.js";

export interface CompoundSpecOpts {
  rpc: RpcClient;
  repoUrl: string;          // git URL Ark clones (e.g., http://localhost:54321/repo.git)
  bareRepoPath: string;     // path of the bare repo on disk (for post-push verification)
  arkDir: string;           // ark data dir (for inspecting agent-env logs + workdir)
  expectedToken: string;    // seeded BITBUCKET_ACCESS_TOKEN
  isHosted: boolean;        // hosted → assert orchestrator=temporal + workflow_id
  /** Optional: webUrl override (defaults to RpcClient's). */
  webUrl?: string;
}

interface SessionRead {
  session: {
    id: string;
    flow: string | null;
    stage: string | null;
    status: string;
    workdir: string | null;
    branch: string | null;
    pr_url: string | null;
    error: string | null;
    orchestrator?: string | null;
    workflow_id?: string | null;
  };
  events?: Array<{ type: string; data?: Record<string, unknown>; stage?: string | null }>;
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; description: string },
): Promise<T> {
  const interval = opts.intervalMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out: ${opts.description}. last=${JSON.stringify(last)}`);
}

/**
 * Compound test body: happy path + manual review gate + stop/resume.
 *
 * Maps to spec Test 1: covers user-spec scenarios a (happy path), c (manual
 * gate approval), d (stop + resume at gate).
 */
export async function compoundDocsFlowSpec(opts: CompoundSpecOpts): Promise<void> {
  const { rpc, repoUrl, bareRepoPath, arkDir, expectedToken, isHosted } = opts;

  // ── 1. Seed BITBUCKET_ACCESS_TOKEN secret ─────────────────────────────
  await rpc.call("secret/set", {
    tenant: "default",
    name: "BITBUCKET_ACCESS_TOKEN",
    value: expectedToken,
    type: "env-var",
  });

  // ── 2. session/start ──────────────────────────────────────────────────
  const startResp = await rpc.call<{ session: SessionRead["session"] }>("session/start", {
    flow: "e2e-docs-review",
    summary: "docs-flow e2e: compound test",
    repo: repoUrl,
  });
  expect(startResp.session.id).toMatch(/^s-/);
  expect(startResp.session.flow).toBe("e2e-docs-review");
  expect(["ready", "running"]).toContain(startResp.session.status);

  if (isHosted) {
    expect(startResp.session.orchestrator).toBe("temporal");
    expect(startResp.session.workflow_id).toMatch(/^session-/);
  }

  const sessionId = startResp.session.id;

  // ── 3. Poll until parked at review_gate ───────────────────────────────
  const parked = await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId, include: ["events"] }),
    (v) => v.session.status === "ready" && v.session.stage === "review",
    { timeoutMs: 30_000, description: `session ${sessionId} parked at review` },
  );

  // ── 4. Assert workspace prepare + clone ran ───────────────────────────
  const workdir = parked.session.workdir;
  if (!workdir) throw new Error("expected session.workdir to be populated after plan");
  expect(existsSync(join(workdir, ".git"))).toBe(true);

  const cloneLog = execFileSync("git", ["-C", workdir, "log", "--oneline"]).toString();
  expect(cloneLog).toContain("initial");   // the seeded commit

  // ── 5. Assert implement stage commit landed ───────────────────────────
  const notes = readFileSync(join(workdir, "NOTES.md"), "utf-8");
  expect(notes).toContain("stub commit at");

  // ── 6. Assert no dispatch_failed leak (regression guard) ──────────────
  const dispatchFailures = (parked.events ?? []).filter((e) => e.type === "dispatch_failed");
  if (dispatchFailures.length > 0) {
    throw new Error(`unexpected dispatch_failed events: ${JSON.stringify(dispatchFailures)}`);
  }

  // ── 7. Stop + resume at the gate ──────────────────────────────────────
  await rpc.call("session/stop", { sessionId });
  await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId }),
    (v) => v.session.status === "stopped",
    { timeoutMs: 10_000, description: "session reaches stopped" },
  );

  await rpc.call("session/resume", { sessionId });
  await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId }),
    (v) => v.session.status === "ready" && v.session.stage === "review",
    { timeoutMs: 10_000, description: "session resumes parked at review" },
  );

  // ── 8. Approve the gate ───────────────────────────────────────────────
  await rpc.call("gate/approve", { sessionId, decision: "approve" });

  // ── 9. Poll until completed ───────────────────────────────────────────
  const final = await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId, include: ["events"] }),
    (v) => ["completed", "failed", "stopped"].includes(v.session.status),
    { timeoutMs: 30_000, description: "session reaches terminal status" },
  );

  // ── 10. Final state assertions ────────────────────────────────────────
  if (final.session.status !== "completed") {
    throw new Error(`expected completed, got ${final.session.status} (stage=${final.session.stage}, error=${final.session.error})`);
  }
  expect(final.session.error).toBeNull();
  expect(final.session.pr_url).toBeTruthy();
  expect(final.session.stage).toBe("pr");

  // ── 11. Verify push reached the bare repo ─────────────────────────────
  const branch = final.session.branch;
  if (!branch) throw new Error("expected session.branch to be set after push");
  const bareLog = execFileSync("git", ["--git-dir", bareRepoPath, "log", branch, "--oneline"]).toString();
  expect(bareLog).toContain("stub-implementer");

  // ── 12. Assert create_pr action ran the real path (not short-circuit) ─
  const createPrEvents = (final.events ?? []).filter(
    (e) => e.type === "action_executed" && (e.data as { action?: string } | undefined)?.action === "create_pr",
  );
  if (createPrEvents.length === 0) {
    throw new Error(`expected at least one action_executed event for create_pr; got events: ${JSON.stringify(final.events?.map(e => e.type))}`);
  }
  for (const e of createPrEvents) {
    const data = e.data as { skipped?: string } | undefined;
    if (data?.skipped === "pr_already_exists") {
      throw new Error("create_pr was short-circuited via pr_already_exists; the real push path must run");
    }
  }

  // ── 13. Verify credential resolution log (debug aid) ──────────────────
  const envLogPath = join(arkDir, "agent-envs", "plan.log");
  if (existsSync(envLogPath)) {
    const env = readFileSync(envLogPath, "utf-8");
    if (!env.includes(expectedToken)) {
      // Soft assertion; the load-bearing check is server 401 → push fails.
      console.warn(`agent-env log did not contain the expected token; verify it was a hidden var`);
    }
  }
}

/**
 * Restart-then-fail test body. Spec Test 2: covers scenarios b (failure path)
 * and g (server restart durability) by killing the server mid-flow and
 * verifying the resumed session surfaces the agent's AuthError.
 *
 * The caller is responsible for the kill+restart cycle (different boot paths
 * between local + hosted), so this body receives a `restart` callback.
 */
export async function restartThenFailSpec(opts: CompoundSpecOpts & {
  /** Kill the running server subprocess. */
  killServer: () => Promise<void>;
  /** Restart the server with same arkDir + same env (including FAIL flag). */
  restartServer: () => Promise<void>;
}): Promise<void> {
  const { rpc, repoUrl, isHosted, expectedToken } = opts;

  await rpc.call("secret/set", {
    tenant: "default",
    name: "BITBUCKET_ACCESS_TOKEN",
    value: expectedToken,
    type: "env-var",
  });

  const startResp = await rpc.call<{ session: SessionRead["session"] }>("session/start", {
    flow: "e2e-docs-review",
    summary: "docs-flow e2e: restart-then-fail",
    repo: repoUrl,
  });
  expect(startResp.session.id).toMatch(/^s-/);
  if (isHosted) {
    expect(startResp.session.orchestrator).toBe("temporal");
    expect(startResp.session.workflow_id).toMatch(/^session-/);
  }
  const sessionId = startResp.session.id;
  const initialWorkflowId = startResp.session.workflow_id;

  // Wait until plan finishes (status becomes "ready" or "running" with stage=implement)
  await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId }),
    (v) => v.session.stage === "implement",
    { timeoutMs: 20_000, description: "plan completes, stage advances to implement" },
  );

  // Kill the server.
  await opts.killServer();

  // Restart with same env (FAIL flag still set).
  await opts.restartServer();

  // For hosted: workflow_id must be unchanged (workflow continues, not a new one).
  if (isHosted) {
    const afterRestart = await rpc.call<SessionRead>("session/read", { sessionId });
    expect(afterRestart.session.workflow_id).toBe(initialWorkflowId);
  }

  // Poll until terminal.
  const final = await waitFor<SessionRead>(
    () => rpc.call<SessionRead>("session/read", { sessionId, include: ["events"] }),
    (v) => ["completed", "failed", "stopped"].includes(v.session.status),
    { timeoutMs: 60_000, description: "session reaches terminal status after restart" },
  );

  // Final state: failed with AuthError, no pr_url, no cold-cache leak.
  expect(final.session.status).toBe("failed");
  expect(final.session.pr_url).toBeNull();
  expect(final.session.stage).toBe("implement");
  expect(final.session.error ?? "").toMatch(/AuthError|401|Unauthorized/);

  // Regression guard: failure must NOT be the cold-cache leak.
  const events = final.events ?? [];
  for (const e of events) {
    const data = e.data as { reason?: string; message?: string } | undefined;
    const haystack = `${data?.reason ?? ""} ${data?.message ?? ""}`;
    if (/No runtime resolvable/.test(haystack)) {
      throw new Error(`unexpected cold-cache leak event: ${JSON.stringify(e)}`);
    }
  }
}
```

- [ ] **Step 2: Type-check**

Run: `bun run tsc --noEmit 2>&1 | grep "docs-flow-spec" | head -5`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add e2e/helpers/docs-flow-spec.ts
git commit -m "feature: add shared docs-flow test bodies (compound + restart-then-fail)"
```

---

## Task 7: Write the local-bespoke test file

**Files:**
- Create: `e2e/local-bespoke.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// e2e/local-bespoke.test.ts
/**
 * Local-mode docs-flow e2e. Boots `ark server start` (default profile, no
 * --hosted, SQLite, single tenant) and runs:
 *   1. Compound test: plan -> implement -> review_gate -> pr (happy path + gate + stop/resume)
 *   2. Restart-then-fail: server killed mid-implement, restarted with FAIL env, session ends failed
 *
 * Mode-agnostic test bodies live in e2e/helpers/docs-flow-spec.ts.
 */

import { describe, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import { execFileSync } from "child_process";

import { startLocalServer } from "./helpers/server-process.js";
import { startGitHttpServer, type GitHttpServerHandle } from "./helpers/git-http-server.js";
import { compoundDocsFlowSpec, restartThenFailSpec } from "./helpers/docs-flow-spec.js";
import { RpcClient } from "./helpers/rpc-client.js";

const REPO_ROOT = resolvePath(__dirname, "..");
const FAKE_CLAUDE_SRC = join(REPO_ROOT, "e2e/fixtures/fake-claude.sh");
const EXPECTED_TOKEN = "test-fake-token-XYZ";
const WEB_PORT = 8420;

function initBareRepoWithSeed(parent: string): string {
  const bare = join(parent, "fake-bitbucket.git");
  mkdirSync(parent, { recursive: true });
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  const working = join(parent, "working");
  execFileSync("git", ["clone", bare, working]);
  execFileSync("bash", ["-c", "echo initial > README.md"], { cwd: working });
  execFileSync("git", ["-C", working, "-c", "user.email=test@x", "-c", "user.name=test", "add", "README.md"]);
  execFileSync("git", ["-C", working, "-c", "user.email=test@x", "-c", "user.name=test", "commit", "-m", "initial"]);
  execFileSync("git", ["-C", working, "push", "origin", "main"]);
  rmSync(working, { recursive: true, force: true });
  return bare;
}

function installFakeClaude(arkDir: string): string {
  const binDir = join(arkDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const dst = join(binDir, "claude");
  copyFileSync(FAKE_CLAUDE_SRC, dst);
  chmodSync(dst, 0o755);
  return binDir;
}

describe("docs-flow e2e — local bespoke", () => {
  // ── Test 1: Compound (happy path + manual gate + stop/resume) ─────────
  describe("compound", () => {
    let arkDir: string;
    let bareRepoParent: string;
    let bareRepoPath: string;
    let gitServer: GitHttpServerHandle;
    let server: Awaited<ReturnType<typeof startLocalServer>>;
    let rpc: RpcClient;

    beforeAll(async () => {
      arkDir = mkdtempSync(join(tmpdir(), "ark-local-compound-"));
      bareRepoParent = mkdtempSync(join(tmpdir(), "ark-local-compound-repo-"));
      bareRepoPath = initBareRepoWithSeed(bareRepoParent);
      const pathPrefix = installFakeClaude(arkDir);

      gitServer = await startGitHttpServer({
        repoPath: bareRepoPath,
        expectedToken: EXPECTED_TOKEN,
        logFile: join(arkDir, "git-auth-log.txt"),
        bindAddr: "127.0.0.1",
      });

      server = await startLocalServer({ arkDir, pathPrefix, webPort: WEB_PORT });
      rpc = new RpcClient(server.webUrl);
    });

    afterAll(async () => {
      try { server?.proc?.kill(); } catch {}
      try { await gitServer?.kill(); } catch {}
      if (arkDir && existsSync(arkDir)) rmSync(arkDir, { recursive: true, force: true });
      if (bareRepoParent && existsSync(bareRepoParent)) rmSync(bareRepoParent, { recursive: true, force: true });
    });

    test("plan -> implement -> review_gate -> pr completes after stop/resume + approve", async () => {
      await compoundDocsFlowSpec({
        rpc,
        repoUrl: gitServer.url,
        bareRepoPath,
        arkDir,
        expectedToken: EXPECTED_TOKEN,
        isHosted: false,
        webUrl: server.webUrl,
      });
    }, 120_000);
  });

  // ── Test 2: Restart-then-fail (durable persistence + AuthError) ────────
  describe("restart-then-fail", () => {
    let arkDir: string;
    let bareRepoParent: string;
    let bareRepoPath: string;
    let gitServer: GitHttpServerHandle;
    let server: Awaited<ReturnType<typeof startLocalServer>>;
    let rpc: RpcClient;
    let pathPrefix: string;

    const FAIL_ENV = { ARK_FAKE_CLAUDE_FAIL_STAGE: "implement" };

    beforeAll(async () => {
      arkDir = mkdtempSync(join(tmpdir(), "ark-local-restartfail-"));
      bareRepoParent = mkdtempSync(join(tmpdir(), "ark-local-restartfail-repo-"));
      bareRepoPath = initBareRepoWithSeed(bareRepoParent);
      pathPrefix = installFakeClaude(arkDir);

      gitServer = await startGitHttpServer({
        repoPath: bareRepoPath,
        expectedToken: EXPECTED_TOKEN,
        logFile: join(arkDir, "git-auth-log.txt"),
        bindAddr: "127.0.0.1",
      });

      server = await startLocalServer({ arkDir, pathPrefix, webPort: WEB_PORT + 1, extraEnv: FAIL_ENV });
      rpc = new RpcClient(server.webUrl);
    });

    afterAll(async () => {
      try { server?.proc?.kill(); } catch {}
      try { await gitServer?.kill(); } catch {}
      if (arkDir && existsSync(arkDir)) rmSync(arkDir, { recursive: true, force: true });
      if (bareRepoParent && existsSync(bareRepoParent)) rmSync(bareRepoParent, { recursive: true, force: true });
    });

    test("session resumes after restart and surfaces AuthError as status=failed", async () => {
      await restartThenFailSpec({
        rpc,
        repoUrl: gitServer.url,
        bareRepoPath,
        arkDir,
        expectedToken: EXPECTED_TOKEN,
        isHosted: false,
        webUrl: server.webUrl,
        killServer: async () => {
          server.proc.kill("SIGKILL");
          await new Promise((r) => setTimeout(r, 500));
        },
        restartServer: async () => {
          server = await startLocalServer({ arkDir, pathPrefix, webPort: WEB_PORT + 1, extraEnv: FAIL_ENV });
          rpc = new RpcClient(server.webUrl);
        },
      });
    }, 180_000);
  });
});
```

- [ ] **Step 2: Type-check**

Run: `bun run tsc --noEmit 2>&1 | grep "local-bespoke" | head -10`
Expected: no errors specific to this file

- [ ] **Step 3: Run the test (expect either pass or specific real failure)**

Run: `bun test e2e/local-bespoke.test.ts 2>&1 | tail -40`

If FAIL: diagnose the failure. Likely categories:
- Helper bug → fix helper
- Spec ambiguity → return to user for clarification, do NOT change assertion
- Production bug → fix in `packages/core/...`, commit separately, retry

- [ ] **Step 4: Commit when green**

```bash
git add e2e/local-bespoke.test.ts
git commit -m "feature: e2e local-bespoke docs-flow tests (compound + restart-then-fail)"
```

---

## Task 8: Update docker-compose.e2e.yaml to bind-mount fake-claude

**Files:**
- Modify: `.infra/docker-compose.e2e.yaml`

- [ ] **Step 1: Read current compose file**

Run: `cat .infra/docker-compose.e2e.yaml`

Identify the sidecar service (or the arkd service if sidecar isolation runs via arkd's helper) — that's where the bind-mount goes.

- [ ] **Step 2: Add the volume entry**

For the service responsible for running the agent inside the sidecar container (consult Task 1's reading; likely `arkd` or a dedicated sidecar image), add:

```yaml
    volumes:
      # ... existing volumes ...
      - ../e2e/fixtures/fake-claude.sh:/usr/local/bin/claude:ro
```

The host path is relative to the compose file location (`.infra/`) → use `../e2e/fixtures/fake-claude.sh`. Mount mode `:ro` (read-only) so the container can't modify it.

- [ ] **Step 3: Validate compose syntax**

Run: `docker compose -f .infra/docker-compose.e2e.yaml config 2>&1 | tail -5`
Expected: prints the resolved compose config; no error

- [ ] **Step 4: Smoke check the mount**

```bash
docker compose -f .infra/docker-compose.e2e.yaml -p ark-e2e up -d --wait
docker compose -f .infra/docker-compose.e2e.yaml -p ark-e2e exec arkd cat /usr/local/bin/claude | head -3
```

Expected: prints the first few lines of fake-claude.sh.

Then teardown: `docker compose -f .infra/docker-compose.e2e.yaml -p ark-e2e down -v`

- [ ] **Step 5: Commit**

```bash
git add .infra/docker-compose.e2e.yaml
git commit -m "chore: bind-mount fake-claude.sh into sidecar for e2e tests"
```

---

## Task 9: Rewrite temporal-control-plane.test.ts

**Files:**
- Modify: `e2e/temporal-control-plane.test.ts` (replace entirely)

- [ ] **Step 1: Read the current file to capture preserved imports/helpers**

Run: `head -80 e2e/temporal-control-plane.test.ts`

Note any imports of helpers we still want to reuse (e.g. `docker-stack`, `server-process` `startHostedServer`, `rpc-client`).

- [ ] **Step 2: Replace the entire file**

```typescript
// e2e/temporal-control-plane.test.ts
/**
 * Hosted-mode docs-flow e2e. Boots `ark server start --hosted` against the
 * Docker compose stack (Postgres + Redis + Temporal + arkd + temporal-worker)
 * with docker-isolation sidecar agents. Runs:
 *   1. Compound test (same body as local-bespoke): plan -> implement ->
 *      review_gate -> pr with stop/resume at the gate.
 *   2. Restart-then-fail: server killed mid-implement, restarted with FAIL
 *      env, session resumes the SAME Temporal workflow and lands failed.
 *
 * Mode-agnostic test bodies live in e2e/helpers/docs-flow-spec.ts.
 */

import { describe, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";

import { startHostedServer, type ServerHandle, type SpawnOptions } from "./helpers/server-process.js";
import * as dockerStack from "./helpers/docker-stack.js";
import { startGitHttpServer, type GitHttpServerHandle } from "./helpers/git-http-server.js";
import { compoundDocsFlowSpec, restartThenFailSpec } from "./helpers/docs-flow-spec.js";
import { RpcClient } from "./helpers/rpc-client.js";

const EXPECTED_TOKEN = "test-fake-token-XYZ";
const WEB_PORT = 8422;

function initBareRepoWithSeed(parent: string): string {
  const bare = join(parent, "fake-bitbucket.git");
  mkdirSync(parent, { recursive: true });
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  const working = join(parent, "working");
  execFileSync("git", ["clone", bare, working]);
  execFileSync("bash", ["-c", "echo initial > README.md"], { cwd: working });
  execFileSync("git", ["-C", working, "-c", "user.email=test@x", "-c", "user.name=test", "add", "README.md"]);
  execFileSync("git", ["-C", working, "-c", "user.email=test@x", "-c", "user.name=test", "commit", "-m", "initial"]);
  execFileSync("git", ["-C", working, "push", "origin", "main"]);
  rmSync(working, { recursive: true, force: true });
  return bare;
}

/** Translate the git server's loopback URL to a docker-reachable one for sidecars. */
function dockerReachable(url: string): string {
  // http://127.0.0.1:PORT/repo.git  →  http://host.docker.internal:PORT/repo.git
  return url.replace(/127\.0\.0\.1/, "host.docker.internal");
}

describe("docs-flow e2e — hosted (Temporal + docker isolation)", () => {
  describe("compound", () => {
    let arkDir: string;
    let bareRepoParent: string;
    let bareRepoPath: string;
    let gitServer: GitHttpServerHandle;
    let server: ServerHandle;
    let rpc: RpcClient;

    beforeAll(async () => {
      arkDir = mkdtempSync(join(tmpdir(), "ark-hosted-compound-"));
      bareRepoParent = mkdtempSync(join(tmpdir(), "ark-hosted-compound-repo-"));
      bareRepoPath = initBareRepoWithSeed(bareRepoParent);

      await dockerStack.up();

      // Bind to 0.0.0.0 so the docker sidecar can reach us via host.docker.internal.
      gitServer = await startGitHttpServer({
        repoPath: bareRepoPath,
        expectedToken: EXPECTED_TOKEN,
        logFile: join(arkDir, "git-auth-log.txt"),
        bindAddr: "0.0.0.0",
      });

      const spawnOpts: SpawnOptions = {
        arkDir,
        webPort: WEB_PORT,
        extraEnv: {
          ARK_FEATURE_TEMPORAL_ORCHESTRATION: "true",
        },
      };
      server = await startHostedServer(spawnOpts);
      rpc = new RpcClient(server.webUrl);
    }, 120_000);

    afterAll(async () => {
      try { server?.proc?.kill(); } catch {}
      try { await gitServer?.kill(); } catch {}
      try { await dockerStack.down(); } catch {}
      if (arkDir && existsSync(arkDir)) rmSync(arkDir, { recursive: true, force: true });
      if (bareRepoParent && existsSync(bareRepoParent)) rmSync(bareRepoParent, { recursive: true, force: true });
    }, 60_000);

    test("plan -> implement -> review_gate -> pr completes after stop/resume + approve", async () => {
      await compoundDocsFlowSpec({
        rpc,
        repoUrl: dockerReachable(gitServer.url),
        bareRepoPath,
        arkDir,
        expectedToken: EXPECTED_TOKEN,
        isHosted: true,
        webUrl: server.webUrl,
      });
    }, 180_000);
  });

  describe("restart-then-fail", () => {
    let arkDir: string;
    let bareRepoParent: string;
    let bareRepoPath: string;
    let gitServer: GitHttpServerHandle;
    let server: ServerHandle;
    let rpc: RpcClient;

    const FAIL_ENV = { ARK_FAKE_CLAUDE_FAIL_STAGE: "implement", ARK_FEATURE_TEMPORAL_ORCHESTRATION: "true" };

    beforeAll(async () => {
      arkDir = mkdtempSync(join(tmpdir(), "ark-hosted-restartfail-"));
      bareRepoParent = mkdtempSync(join(tmpdir(), "ark-hosted-restartfail-repo-"));
      bareRepoPath = initBareRepoWithSeed(bareRepoParent);

      await dockerStack.up();

      gitServer = await startGitHttpServer({
        repoPath: bareRepoPath,
        expectedToken: EXPECTED_TOKEN,
        logFile: join(arkDir, "git-auth-log.txt"),
        bindAddr: "0.0.0.0",
      });

      server = await startHostedServer({ arkDir, webPort: WEB_PORT + 10, extraEnv: FAIL_ENV });
      rpc = new RpcClient(server.webUrl);
    }, 120_000);

    afterAll(async () => {
      try { server?.proc?.kill(); } catch {}
      try { await gitServer?.kill(); } catch {}
      try { await dockerStack.down(); } catch {}
      if (arkDir && existsSync(arkDir)) rmSync(arkDir, { recursive: true, force: true });
      if (bareRepoParent && existsSync(bareRepoParent)) rmSync(bareRepoParent, { recursive: true, force: true });
    }, 60_000);

    test("session resumes after server restart and surfaces AuthError as status=failed", async () => {
      await restartThenFailSpec({
        rpc,
        repoUrl: dockerReachable(gitServer.url),
        bareRepoPath,
        arkDir,
        expectedToken: EXPECTED_TOKEN,
        isHosted: true,
        webUrl: server.webUrl,
        killServer: async () => {
          server.proc.kill("SIGKILL");
          await new Promise((r) => setTimeout(r, 500));
        },
        restartServer: async () => {
          server = await startHostedServer({ arkDir, webPort: WEB_PORT + 10, extraEnv: FAIL_ENV });
          rpc = new RpcClient(server.webUrl);
        },
      });
    }, 240_000);
  });
});
```

- [ ] **Step 3: Type-check**

Run: `bun run tsc --noEmit 2>&1 | grep "temporal-control-plane" | head -5`
Expected: no errors specific to this file. If `startHostedServer` or `SpawnOptions` signature has changed since Task 5, reconcile here.

- [ ] **Step 4: Run hosted tests**

Run: `make test-e2e-control-plane 2>&1 | tail -30`

If FAIL: diagnose. Same rules as Task 7 Step 3 — fix code/helpers, never the assertion.

- [ ] **Step 5: Commit**

```bash
git add e2e/temporal-control-plane.test.ts
git commit -m "feature: rewrite temporal-control-plane.test.ts (488 lines -> ~150, 8 tests -> 2)"
```

---

## Task 10: Delete dead files

**Files:**
- Delete: `e2e/control-plane.test.ts`
- Delete: `e2e/fixtures/stub-runner-executor.mjs`
- Delete: `e2e/fixtures/stub-agent.sh`
- Delete: `e2e/fixtures/flows/e2e-review.yaml`
- Delete: `flows/definitions/e2e-docs.yaml`
- Delete: `flows/definitions/e2e-noop.yaml`

- [ ] **Step 1: Verify no references remain**

```bash
grep -rn "control-plane.test.ts\|stub-runner-executor\|stub-agent.sh\|e2e-review\|e2e-docs\|e2e-noop" \
  --include="*.ts" --include="*.yaml" --include="*.mjs" --include="*.sh" --include="Makefile" \
  packages e2e .infra Makefile 2>/dev/null | grep -v "docs-flow-e2e-design.md\|docs-flow-e2e.md" | head -20
```

Expected: only references in the spec/plan docs and in test code we control. Any other hit means a stale reference we need to fix first.

- [ ] **Step 2: Audit stub-closer.yaml**

```bash
grep -rn "stub-closer" --include="*.ts" --include="*.yaml" e2e packages 2>/dev/null
```

If only the YAML itself appears (no flow references it), delete it too.

- [ ] **Step 3: Delete the files**

```bash
git rm e2e/control-plane.test.ts \
  e2e/fixtures/stub-runner-executor.mjs \
  e2e/fixtures/stub-agent.sh \
  e2e/fixtures/flows/e2e-review.yaml \
  flows/definitions/e2e-docs.yaml \
  flows/definitions/e2e-noop.yaml
```

If stub-closer.yaml is orphaned:

```bash
git rm e2e/fixtures/agents/stub-closer.yaml
```

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove obsolete e2e tests/fixtures replaced by docs-flow-e2e"
```

---

## Task 11: Update Makefile targets

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Find existing e2e targets**

Run: `grep -n "test-e2e" Makefile | head -10`

- [ ] **Step 2: Add local target + rename for clarity if needed**

Append (or insert near other e2e targets):

```makefile
.PHONY: test-e2e-local-bespoke
test-e2e-local-bespoke: ## Run local-mode docs-flow e2e (SQLite, no Docker)
	@echo "$(bold)Running local-mode docs-flow e2e...$(reset)"
	@bun test e2e/local-bespoke.test.ts
```

If `test-e2e-control-plane` currently runs both `e2e/control-plane.test.ts` and `e2e/temporal-control-plane.test.ts`, update it to only run the latter (since the former is deleted).

- [ ] **Step 3: Smoke check**

```bash
make help 2>&1 | grep test-e2e
```

Expected: `test-e2e-local-bespoke` listed.

- [ ] **Step 4: Commit**

```bash
git add Makefile
git commit -m "chore: add test-e2e-local-bespoke target; refine control-plane target"
```

---

## Task 12: Final verification — run both targets from clean state

- [ ] **Step 1: Run local target**

```bash
make test-e2e-local-bespoke 2>&1 | tail -30
```

Expected: 2 of 2 tests pass.

- [ ] **Step 2: Run hosted target**

```bash
make test-e2e-control-plane-down 2>&1 | tail -3
make test-e2e-control-plane 2>&1 | tail -30
```

Expected: 2 of 2 tests pass.

- [ ] **Step 3: If anything failed**

Do NOT relax any assertion. Diagnose root cause:

- Stub-side bug → fix the helper, retry
- Product bug → fix in `packages/core/...`, commit separately as `fix:`, retry
- Spec ambiguity → STOP and return to user for clarification

- [ ] **Step 4: Final commit (if any fixes were needed)**

```bash
git commit -am "fix: <whatever specific issue>"
```

- [ ] **Step 5: Push the branch**

```bash
git push -u origin docs-flow-e2e
```

---

## Self-Review Checklist

After all tasks complete, verify against the spec:

| Spec requirement | Plan task |
|---|---|
| `e2e/fixtures/flows/e2e-docs-review.yaml` exists with `requires_repo: true` | Task 1 |
| Fake claude binary handles per-stage logic + failure injection | Task 2 |
| Agents declare `runtime: claude-code` | Task 3 |
| `git-http-server.ts` enforces basic auth via `git-http-backend` | Task 4 |
| `startLocalServer()` boots default-profile server, polls health + RPC | Task 5 |
| Shared spec body asserts: clone, implement commit, gate park, stop/resume, gate approve, completion, push reached bare repo, no `dispatch_failed`, `create_pr` not short-circuited | Task 6 |
| `e2e/local-bespoke.test.ts` runs compound + restart-fail | Task 7 |
| Docker compose bind-mounts fake-claude into sidecar | Task 8 |
| Hosted test file rewritten to 2 tests using shared body | Task 9 |
| Old files deleted | Task 10 |
| Makefile target added | Task 11 |
| All 4 tests pass from clean state | Task 12 |

If any row above has no matching task or any task has a placeholder, fix inline.
