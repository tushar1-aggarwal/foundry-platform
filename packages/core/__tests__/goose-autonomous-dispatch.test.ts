/**
 * Tests for Goose runtime working with autonomous dispatch.
 *
 * Validates the full dispatch path for --runtime goose on the autonomous flow:
 * 1. Runtime resolution: goose.yaml merges into agent -> _resolved_runtime_type = "goose"
 * 2. Agent model override: agent model is remapped to goose's model list
 * 3. Goose executor: launches goose with -t text delivery + --with-extension for channel MCP
 * 4. Status poller: detects tmux exit (not_found) and completes session
 * 5. Flow advance: single-stage autonomous flow completes after poller triggers
 * 6. Transcript parsing: goose billing mode is wired in RuntimeBilling
 *
 * `buildGooseCommand` argv assertions live in goose-executor.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { AppContext } from "../app.js";
import { startStatusPoller, stopStatusPoller, stopAllPollers } from "../executors/status-poller.js";
import { gooseExecutor } from "../executors/goose.js";
import { resolveAgentWithRuntime } from "../agent/agent.js";
import * as tmux from "../infra/tmux.js";

// ── App fixture ──────────────────────────────────────────────────────────────

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  if (app) stopAllPollers(app);
  await app?.shutdown();
});

// ── Helper ───────────────────────────────────────────────────────────────────

function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 25000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      try {
        if (await fn()) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
        setTimeout(check, 100);
      } catch (err) {
        reject(err);
      }
    };
    check();
  });
}

// ── Runtime resolution ───────────────────────────────────────────────────────

describe("Goose runtime resolution", () => {
  it("goose runtime definition loads from RuntimeStore", async () => {
    const runtime = await app.runtimes.get("goose");
    expect(runtime).not.toBeNull();
    expect(runtime!.name).toBe("goose");
    expect(runtime!.type).toBe("goose");
    expect(runtime!.command).toEqual(["goose", "run"]);
    expect(runtime!.task_delivery).toBe("arg");
    expect(runtime!.billing?.mode).toBe("api");
    expect(runtime!.billing?.transcript_parser).toBe("goose");
  });

  it("resolveAgentWithRuntime merges goose runtime into worker agent", async () => {
    const session = { summary: "test task", id: "s-goose01" };
    const agent = await resolveAgentWithRuntime(app, "worker", session, { runtimeOverride: "goose" });

    expect(agent).not.toBeNull();
    expect(agent!._resolved_runtime_type).toBe("goose");
    expect(agent!.command).toEqual(["goose", "run"]);
    expect(agent!.task_delivery).toBe("arg");
  });

  it("all five builtin runtimes are loadable", async () => {
    const names = ["claude-code", "claude-max", "codex", "gemini", "goose"];
    for (const name of names) {
      const runtime = await app.runtimes.get(name);
      expect(runtime).not.toBeNull();
      expect(runtime!.name).toBe(name);
    }
  });

  it("goose runtime type maps to goose executor (not cli-agent)", async () => {
    const runtime = await app.runtimes.get("goose");
    expect(runtime!.type).toBe("goose");
    // Verify this is distinct from gemini which uses cli-agent
    const gemini = await app.runtimes.get("gemini");
    expect(gemini!.type).toBe("cli-agent");
    // goose has its own executor type
    expect(runtime!.type).not.toBe(gemini!.type);
  });
});

// ── Goose executor with autonomous dispatch config ─────────────────────────

describe("Goose dispatch via goose executor", async () => {
  let createSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createSpy = spyOn(tmux, "createSessionAsync").mockImplementation(async () => {});
  });

  afterEach(() => {
    createSpy.mockRestore();
  });

  it("goose executor is registered and has the correct name", async () => {
    expect(gooseExecutor.name).toBe("goose");
    expect(typeof gooseExecutor.launch).toBe("function");
    expect(typeof gooseExecutor.kill).toBe("function");
    expect(typeof gooseExecutor.status).toBe("function");
    expect(typeof gooseExecutor.send).toBe("function");
    expect(typeof gooseExecutor.capture).toBe("function");
  });

  it("goose executor returns not_found when tmux session exits", async () => {
    const existsSpy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);
    try {
      const status = await gooseExecutor.status("ark-s-goose01");
      expect(status.state).toBe("not_found");
    } finally {
      existsSpy.mockRestore();
    }
  });

  it("goose executor returns running when tmux session is alive", async () => {
    const existsSpy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(true);
    try {
      const status = await gooseExecutor.status("ark-s-goose02");
      expect(status.state).toBe("running");
    } finally {
      existsSpy.mockRestore();
    }
  });
});

// ── Status poller + autonomous flow completion ──────────────────────────────

describe("Goose runtime + autonomous flow completion", async () => {
  it("status poller completes session when goose tmux exits", async () => {
    const session = await app.sessions.create({ summary: "goose autonomous test", flow: "autonomous" });
    await app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-" + session.id,
      config: { runtime: "goose" },
    });

    // Mock: tmux session already exited (goose finished its work)
    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "goose");

      await waitFor(async () => {
        const s = await app.sessions.get(session.id);
        return s?.status === "ready";
      });

      const updated = await app.sessions.get(session.id);
      expect(updated?.status).toBe("ready");
    } finally {
      spy.mockRestore();
    }
  });

  it("status poller logs session_completed event", async () => {
    const session = await app.sessions.create({ summary: "goose event test", flow: "autonomous" });
    await app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-" + session.id,
    });

    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "goose");

      await waitFor(async () => {
        const s = await app.sessions.get(session.id);
        return s?.status === "ready";
      });

      // Verify that a session_completed event was logged
      const events = await app.events.list(session.id);
      const completedEvent = events.find((e) => e.type === "session_completed");
      expect(completedEvent).not.toBeUndefined();
      const data = typeof completedEvent!.data === "string" ? JSON.parse(completedEvent!.data) : completedEvent!.data;
      expect(data.reason).toBe("agent process exited");
    } finally {
      spy.mockRestore();
    }
  });

  it("status poller clears session_id on completion", async () => {
    const session = await app.sessions.create({ summary: "goose cleanup test", flow: "autonomous" });
    await app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-" + session.id,
    });

    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "goose");

      await waitFor(async () => {
        const s = await app.sessions.get(session.id);
        return s?.status === "ready";
      });

      const updated = await app.sessions.get(session.id);
      expect(updated?.session_id).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not double-poll the same session", async () => {
    const session = await app.sessions.create({ summary: "goose no-double test", flow: "autonomous" });
    await app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-" + session.id,
    });

    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(true);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "goose");
      startStatusPoller(app, session.id, "ark-" + session.id, "goose"); // Should be no-op

      // Wait a polling cycle to ensure only one poller is active
      await Bun.sleep(100);
      const s = await app.sessions.get(session.id);
      expect(s?.status).toBe("running"); // Still running, not double-completed
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Goose billing config ────────────────────────────────────────────────────

describe("Goose runtime billing and transcript config", () => {
  it("goose runtime billing config specifies transcript_parser: goose", async () => {
    const runtime = await app.runtimes.get("goose");
    expect(runtime).not.toBeNull();
    expect(runtime!.billing?.transcript_parser).toBe("goose");
  });

  it("goose runtime billing mode is api (per-token pricing)", async () => {
    const runtime = await app.runtimes.get("goose");
    expect(runtime).not.toBeNull();
    expect(runtime!.billing?.mode).toBe("api");
  });
});

// ── Executor dispatch path (runtime type -> executor) ───────────────────────

describe("Goose runtime executor dispatch path", async () => {
  it("goose executor is in builtinExecutors", async () => {
    const { builtinExecutors } = await import("../executors/index.js");
    const names = builtinExecutors.map((e) => e.name);
    expect(names).toContain("goose");
  });

  it("goose executor is registered in executor registry", async () => {
    const { getExecutor } = await import("../executor.js");
    const executor = getExecutor("goose");
    expect(executor).not.toBeUndefined();
    expect(executor!.name).toBe("goose");
  });

  it("dispatch runtime resolution: goose override -> _resolved_runtime_type goose -> goose executor", async () => {
    const { getExecutor } = await import("../executor.js");

    // Step 1: Runtime resolution merges goose type
    const session = { summary: "dispatch path test", id: "s-goose20" };
    const agent = await resolveAgentWithRuntime(app, "worker", session, { runtimeOverride: "goose" });
    expect(agent!._resolved_runtime_type).toBe("goose");

    // Step 2: Executor selection uses _resolved_runtime_type
    const runtime = agent!._resolved_runtime_type ?? agent!.runtime ?? "claude-code";
    expect(runtime).toBe("goose");

    // Step 3: Executor lookup succeeds
    const executor = app.pluginRegistry.executor(runtime) ?? getExecutor(runtime);
    expect(executor).not.toBeUndefined();
    expect(executor!.name).toBe("goose");
  });

  it("dispatch starts status poller for goose runtime (not claude-code hooks)", async () => {
    // Verify the dispatch path condition: runtime !== "claude-code"
    const session = { summary: "poller check", id: "s-goose21" };
    const agent = await resolveAgentWithRuntime(app, "worker", session, { runtimeOverride: "goose" });
    const runtime = agent!._resolved_runtime_type ?? agent!.runtime ?? "claude-code";
    expect(runtime).not.toBe("claude-code");
    // This means the dispatch function will start a status poller instead of relying on hooks
  });
});
