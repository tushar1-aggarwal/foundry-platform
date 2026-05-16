/**
 * Tests for the harness detection cascade.
 *
 * Coverage:
 *   - Layer 1: existing .claude/.cursor/.codex skill dirs
 *   - Layer 2: config.enabled_harnesses (fallback when Layer 1 empty)
 *   - Layer 3: scoping override callback
 *   - Layer 4: interactive prompt callback
 *   - enabled_harnesses filter applied on top of Layers 1/3/4 (but NOT Layer 2 - that IS the filter)
 *   - Unknown harness ids dropped (typo in config or scoping)
 *   - DetectError when every layer is empty
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DetectError, detectHarnesses } from "../skills/detect.js";
import { registry as realRegistry } from "../../skill-adapters/index.js";
import type { HarnessAdapter } from "../../skill-adapters/index.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "skillhub-cli-detect-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/** Drop a fake `<harness>/<name>/SKILL.md` into the repo so Layer 1 fires. */
function seedSkillDir(harness: "claude" | "cursor" | "codex", name: string): void {
  const dir = join(repoRoot, `.${harness}`, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: " + name + "\ndescription: x\n---\n");
}

describe("Layer 1 — existing skill dirs", () => {
  it("detects a single harness from an existing dir", async () => {
    seedSkillDir("claude", "code-review");
    const result = await detectHarnesses({ repoRoot, registry: realRegistry, config: null });
    expect(result.source).toBe("existing-dirs");
    expect(result.harnesses.sort()).toEqual(["claude"]);
  });

  it("detects multiple harnesses when their dirs coexist", async () => {
    seedSkillDir("claude", "alpha");
    seedSkillDir("cursor", "beta");
    seedSkillDir("codex", "gamma");
    const result = await detectHarnesses({ repoRoot, registry: realRegistry, config: null });
    expect(result.source).toBe("existing-dirs");
    expect(result.harnesses.sort()).toEqual(["claude", "codex", "cursor"]);
  });

  it("does not fire when the dir exists but contains no <name>/SKILL.md", async () => {
    mkdirSync(join(repoRoot, ".claude", "skills"), { recursive: true });
    // Empty dir - no skills inside.
    await expect(detectHarnesses({ repoRoot, registry: realRegistry, config: null })).rejects.toThrow(DetectError);
  });

  it("does not fire when the dir contains a hidden file (.DS_Store etc.)", async () => {
    const claude = join(repoRoot, ".claude", "skills");
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, ".DS_Store"), "junk");
    await expect(detectHarnesses({ repoRoot, registry: realRegistry, config: null })).rejects.toThrow(DetectError);
  });
});

describe("Layer 2 — config.enabled_harnesses (Layer 1 empty)", () => {
  it("returns enabled_harnesses when Layer 1 has nothing", async () => {
    const result = await detectHarnesses({
      repoRoot,
      registry: realRegistry,
      config: { enabled_harnesses: ["claude", "cursor"] },
    });
    expect(result.source).toBe("config");
    expect(result.harnesses).toEqual(["claude", "cursor"]);
  });

  it("empty enabled_harnesses array does NOT short-circuit at Layer 2; falls through to Layer 3+", async () => {
    // Documented intent: `[]` means "I forgot to fill this in," not
    // "block everything." Falls through to scoping / prompt so the
    // user gets a real answer instead of an empty result.
    const result = await detectHarnesses({
      repoRoot,
      registry: realRegistry,
      config: { enabled_harnesses: [] },
      resolveScopingDefault: async () => "cursor",
    });
    expect(result.source).toBe("scoping");
    expect(result.harnesses).toEqual(["cursor"]);
  });

  it("does NOT win when Layer 1 fired; Layer 1's result is filtered by enabled_harnesses instead", async () => {
    seedSkillDir("claude", "x");
    seedSkillDir("cursor", "y");
    const result = await detectHarnesses({
      repoRoot,
      registry: realRegistry,
      config: { enabled_harnesses: ["claude"] }, // restriction
    });
    expect(result.source).toBe("existing-dirs");
    expect(result.harnesses).toEqual(["claude"]); // cursor filtered out
  });

  it("drops unknown harness ids (typo in config)", async () => {
    const result = await detectHarnesses({
      repoRoot,
      registry: realRegistry,
      config: { enabled_harnesses: ["claude", "made-up-harness"] },
    });
    expect(result.source).toBe("config");
    expect(result.harnesses).toEqual(["claude"]);
  });
});

describe("Layer 3 — scoping override (Layers 1, 2 empty)", () => {
  it("returns the resolved default", async () => {
    const result = await detectHarnesses({
      repoRoot,
      registry: realRegistry,
      config: null,
      resolveScopingDefault: async () => "cursor",
    });
    expect(result.source).toBe("scoping");
    expect(result.harnesses).toEqual(["cursor"]);
  });

  it("falls through when the resolver returns null", async () => {
    await expect(
      detectHarnesses({
        repoRoot,
        registry: realRegistry,
        config: null,
        resolveScopingDefault: async () => null,
      }),
    ).rejects.toThrow(DetectError);
  });

  it("drops unknown harness id (typo in scoping value)", async () => {
    const result = await detectHarnesses({
      repoRoot,
      registry: realRegistry,
      config: null,
      resolveScopingDefault: async () => "nonexistent-harness",
    });
    // After filtering: empty. Source still 'scoping' since that's where the candidate came from.
    expect(result.harnesses).toEqual([]);
  });
});

describe("Layer 4 — interactive prompt (everything above empty)", () => {
  it("returns the user's choice", async () => {
    const result = await detectHarnesses({
      repoRoot,
      registry: realRegistry,
      config: null,
      promptUser: async () => "claude",
    });
    expect(result.source).toBe("prompt");
    expect(result.harnesses).toEqual(["claude"]);
  });

  it("throws DetectError when the user bails (returns null)", async () => {
    await expect(
      detectHarnesses({
        repoRoot,
        registry: realRegistry,
        config: null,
        promptUser: async () => null,
      }),
    ).rejects.toThrow(DetectError);
  });

  it("throws DetectError when no promptUser is supplied (caller passed --no-interactive)", async () => {
    await expect(detectHarnesses({ repoRoot, registry: realRegistry, config: null })).rejects.toThrow(DetectError);
  });
});

describe("enabled_harnesses semantics", () => {
  it("filters a Layer 1 multi-harness result (the only layer where the filter is consequential)", async () => {
    seedSkillDir("claude", "a");
    seedSkillDir("cursor", "b");
    seedSkillDir("codex", "c");
    const result = await detectHarnesses({
      repoRoot,
      registry: realRegistry,
      config: { enabled_harnesses: ["claude", "codex"] },
    });
    expect(result.source).toBe("existing-dirs");
    expect(result.harnesses.sort()).toEqual(["claude", "codex"]);
  });

  it("Layers 3 and 4 are unreachable when enabled_harnesses is set and Layer 1 is empty", async () => {
    // Layer 2 short-circuits the cascade; the scoping / prompt
    // callbacks are never invoked. We assert that by using rejecting
    // callbacks - if they ran, the test would throw.
    const result = await detectHarnesses({
      repoRoot,
      registry: realRegistry,
      config: { enabled_harnesses: ["cursor"] },
      resolveScopingDefault: async () => {
        throw new Error("Layer 3 should not have been invoked");
      },
      promptUser: async () => {
        throw new Error("Layer 4 should not have been invoked");
      },
    });
    expect(result.source).toBe("config");
    expect(result.harnesses).toEqual(["cursor"]);
  });
});

describe("custom registry", () => {
  it("respects a non-default registry (e.g. a future harness)", async () => {
    // Build a fake adapter whose readPath we can populate.
    const fooAdapter: HarnessAdapter = {
      harnessId: "foo",
      readPaths: (root) => [join(root, ".foo", "skills")],
      defaultWritePath: (root) => join(root, ".foo", "skills"),
      parse: () => {
        throw new Error("not used in detection");
      },
      render: () => [],
    };
    const dir = join(repoRoot, ".foo", "skills", "x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: x\ndescription: y\n---\n");

    const result = await detectHarnesses({ repoRoot, registry: [fooAdapter], config: null });
    expect(result.source).toBe("existing-dirs");
    expect(result.harnesses).toEqual(["foo"]);
  });
});
