/**
 * Codex adapter tests. Round-trip + the codex-specific multi-readPath
 * behavior (`.codex/skills/` + `.agents/skills/`) + telemetry on
 * Claude-origin rendering.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { codexAdapter } from "../codex.js";
import { clearBuffer, disableTelemetry, enableTelemetry, getBuffer } from "../../core/observability/telemetry.js";
import type { CanonicalSkill, WrittenFile } from "../types.js";

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "skill-adapter-codex-"));
  enableTelemetry();
  clearBuffer();
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
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

describe("codexAdapter — identity + paths", () => {
  it("declares its harnessId", () => {
    expect(codexAdapter.harnessId).toBe("codex");
  });

  it("readPaths includes both .codex/skills and .agents/skills (universal convention)", () => {
    expect(codexAdapter.readPaths("/repo")).toEqual(["/repo/.codex/skills", "/repo/.agents/skills"]);
  });

  it("defaultWritePath is .codex/skills (the harness-native location, not .agents)", () => {
    expect(codexAdapter.defaultWritePath("/repo")).toBe("/repo/.codex/skills");
  });
});

describe("codexAdapter — round-trip", () => {
  it("render -> write -> parse reconstructs the LocalSkill", () => {
    const canonical: CanonicalSkill = {
      name: "deploy",
      description: "Deploy the app",
      body: "# deploy\n\nSteps...\n",
      supportingFiles: [{ path: "scripts/run.sh", content: "#!/bin/sh\necho deploy\n" }],
      category: "ops",
      tags: ["deploy"],
      harnessHints: { codex: {} },
    };
    const files = codexAdapter.render(canonical);
    writeFiles(scratchDir, files);
    const local = codexAdapter.parse(scratchDir);
    expect(local.name).toBe(canonical.name);
    expect(local.body).toBe(canonical.body);
    expect(local.supportingFiles).toEqual(canonical.supportingFiles);
  });
});

describe("codexAdapter — RFC §9 Q2 telemetry", () => {
  it("emits skillhub.cross_harness_render with target_harness=codex when rendering a Claude-origin skill", () => {
    const canonical: CanonicalSkill = {
      name: "claude-flavored",
      description: "Authored via Claude",
      body: "body\n",
      supportingFiles: [],
      category: null,
      tags: [],
      harnessHints: {
        claude: { "disable-model-invocation": true },
        codex: {},
      },
    };
    codexAdapter.render(canonical);
    const events = getBuffer().filter((e) => e.event === "skillhub.cross_harness_render");
    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      source_harness: "claude",
      target_harness: "codex",
    });
  });

  it("does NOT emit telemetry for codex-native skills", () => {
    const canonical: CanonicalSkill = {
      name: "codex-native",
      description: "Authored in Codex",
      body: "body\n",
      supportingFiles: [],
      category: null,
      tags: [],
      harnessHints: { codex: {} },
    };
    codexAdapter.render(canonical);
    const events = getBuffer().filter((e) => e.event === "skillhub.cross_harness_render");
    expect(events).toHaveLength(0);
  });
});
