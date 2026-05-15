/**
 * Cursor adapter tests. Round-trip + identity + cross-harness telemetry.
 * The shared parse / render helpers are exercised more thoroughly by
 * claude.test.ts; this file focuses on cursor-specific concerns:
 * identity (harness id + paths), basic round-trip, and the §9 Q2
 * telemetry counter firing when rendering a Claude-origin skill.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { cursorAdapter } from "../cursor.js";
import { clearBuffer, disableTelemetry, enableTelemetry, getBuffer } from "../../core/observability/telemetry.js";
import type { CanonicalSkill, WrittenFile } from "../types.js";

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "skill-adapter-cursor-"));
  // Telemetry is opt-in (off by default in tests). Enable + flush so
  // tests can assert on the exact events emitted.
  enableTelemetry();
  clearBuffer();
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
  // Restore the global telemetry flag so subsequent tests in the same
  // process don't inherit the "on" state. clearBuffer flushes whatever
  // events were collected during this test.
  disableTelemetry();
  clearBuffer();
});

function writeFiles(skillRoot: string, files: WrittenFile[]): void {
  for (const f of files) {
    const abs = join(skillRoot, f.relativePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

describe("cursorAdapter — identity + paths", () => {
  it("declares its harnessId and read/write paths", () => {
    expect(cursorAdapter.harnessId).toBe("cursor");
    expect(cursorAdapter.readPaths("/repo")).toEqual(["/repo/.cursor/skills"]);
    expect(cursorAdapter.defaultWritePath("/repo")).toBe("/repo/.cursor/skills");
  });
});

describe("cursorAdapter — round-trip", () => {
  it("render -> write -> parse reconstructs the LocalSkill (cursor-flavored skill)", () => {
    const canonical: CanonicalSkill = {
      name: "code-review",
      description: "Review the diff",
      body: "# code-review\n\nDo the thing.\n",
      supportingFiles: [{ path: "refs/spec.md", content: "spec\n" }],
      category: "review",
      tags: ["review"],
      harnessHints: { cursor: {}, codex: {} },
    };
    const files = cursorAdapter.render(canonical);
    writeFiles(scratchDir, files);
    const local = cursorAdapter.parse(scratchDir);
    expect(local.name).toBe(canonical.name);
    expect(local.description).toBe(canonical.description);
    expect(local.body).toBe(canonical.body);
    expect(local.supportingFiles).toEqual(canonical.supportingFiles);
    expect(local.harnessHints.cursor).toEqual({});
  });
});

describe("cursorAdapter — RFC §9 Q2 telemetry", () => {
  it("emits skillhub.cross_harness_render when rendering a skill with Claude-specific hints", () => {
    const canonical: CanonicalSkill = {
      name: "claude-flavored",
      description: "Authored via Claude",
      body: "body\n",
      supportingFiles: [],
      category: null,
      tags: [],
      harnessHints: {
        claude: { "disable-model-invocation": false, "allowed-tools": ["Bash(git *)"] },
        cursor: {},
      },
    };
    cursorAdapter.render(canonical);
    const events = getBuffer().filter((e) => e.event === "skillhub.cross_harness_render");
    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      source_harness: "claude",
      target_harness: "cursor",
    });
  });

  it("does NOT emit telemetry when there is no Claude origin", () => {
    const canonical: CanonicalSkill = {
      name: "cursor-native",
      description: "Authored natively in Cursor",
      body: "body\n",
      supportingFiles: [],
      category: null,
      tags: [],
      harnessHints: { cursor: { "some-cursor-key": "value" } },
    };
    cursorAdapter.render(canonical);
    const events = getBuffer().filter((e) => e.event === "skillhub.cross_harness_render");
    expect(events).toHaveLength(0);
  });

  it("does NOT emit telemetry when harnessHints.claude is present but empty (no Claude-specific extensions)", () => {
    const canonical: CanonicalSkill = {
      name: "stripped",
      description: "Touched Claude but no extensions",
      body: "body\n",
      supportingFiles: [],
      category: null,
      tags: [],
      harnessHints: { claude: {}, cursor: {} },
    };
    cursorAdapter.render(canonical);
    const events = getBuffer().filter((e) => e.event === "skillhub.cross_harness_render");
    expect(events).toHaveLength(0);
  });
});
