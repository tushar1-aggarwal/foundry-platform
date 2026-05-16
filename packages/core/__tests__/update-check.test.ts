import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getCurrentVersion, checkForUpdate } from "../infra/update-check.js";
import { withTestContext } from "./test-helpers.js";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("getCurrentVersion", () => {
  it("returns a version string", () => {
    const version = getCurrentVersion();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });

  it("returns semver-like format or fallback", () => {
    const version = getCurrentVersion();
    // Either a valid version like "1.0.0" or the fallback "0.0.0"
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("checkForUpdate", async () => {
  it("respects rate limiting from saved state", async () => {
    // Write a recent check state so it skips the network call
    const statePath = join(getApp().config.dirs.ark, "update-check.json");
    const state = {
      lastCheck: new Date().toISOString(),
      latestVersion: getCurrentVersion(),
      currentVersion: getCurrentVersion(),
    };
    writeFileSync(statePath, JSON.stringify(state));

    const result = await checkForUpdate(getApp().config.dirs.ark);
    // Same version as current = no update
    expect(result).toBeNull();
  });

  it("reports update when saved state has newer version", async () => {
    const statePath = join(getApp().config.dirs.ark, "update-check.json");
    const state = {
      lastCheck: new Date().toISOString(),
      latestVersion: "99.99.99",
      currentVersion: getCurrentVersion(),
    };
    writeFileSync(statePath, JSON.stringify(state));

    const result = await checkForUpdate(getApp().config.dirs.ark);
    expect(result).toBe("99.99.99");
  });

  it("handles corrupted state file gracefully (no throw)", async () => {
    const statePath = join(getApp().config.dirs.ark, "update-check.json");
    writeFileSync(statePath, "not-valid-json{{{");

    // The contract is no-throw; the return value depends on whether
    // the network call from the fall-through path succeeds, which we
    // don't pin here. If a future version adds a network mock, tighten
    // this to a specific expected value.
    await checkForUpdate(getApp().config.dirs.ark);
  });
});
