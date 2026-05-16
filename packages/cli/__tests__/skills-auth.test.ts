/**
 * Tests for Anthropic credential discovery (used by `ark skills sync`).
 *
 * Coverage:
 *   - ANTHROPIC_API_KEY env wins when set
 *   - CLAUDE_CODE_OAUTH_TOKEN env is a valid path (Claude Code Max sub)
 *   - ark secrets fallback when env is unset
 *   - NoCredentialsError when nothing is found, with hints in the message
 *   - Whitespace-only env values do NOT count as set
 */

import { describe, expect, it } from "bun:test";
import { NoCredentialsError, discoverAnthropicCredentials } from "../skills/auth.js";

describe("discoverAnthropicCredentials — happy paths", () => {
  it("returns env-api-key when ANTHROPIC_API_KEY is set", async () => {
    const r = await discoverAnthropicCredentials({
      env: { ANTHROPIC_API_KEY: "sk-ant-test-key" },
    });
    expect(r).toEqual({
      token: "sk-ant-test-key",
      source: "env-api-key",
      kind: "api-key",
      sourceDetail: "ANTHROPIC_API_KEY",
    });
  });

  it("returns env-oauth-token when CLAUDE_CODE_OAUTH_TOKEN is set (Claude Code Max sub)", async () => {
    const r = await discoverAnthropicCredentials({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-aaa" },
    });
    expect(r).toEqual({
      token: "sk-ant-oat01-aaa",
      source: "env-oauth-token",
      kind: "oauth-token",
      sourceDetail: "CLAUDE_CODE_OAUTH_TOKEN",
    });
  });

  it("ANTHROPIC_API_KEY beats CLAUDE_CODE_OAUTH_TOKEN when both are present", async () => {
    const r = await discoverAnthropicCredentials({
      env: { ANTHROPIC_API_KEY: "from-api", CLAUDE_CODE_OAUTH_TOKEN: "from-oauth" },
    });
    expect(r.source).toBe("env-api-key");
    expect(r.token).toBe("from-api");
  });

  it("trims whitespace around the env value", async () => {
    const r = await discoverAnthropicCredentials({
      env: { ANTHROPIC_API_KEY: "  sk-ant-padded  \n" },
    });
    expect(r.token).toBe("sk-ant-padded");
  });

  it("falls back to ark secrets when env is absent", async () => {
    // Default secret name must satisfy the [A-Z0-9_]+ constraint in
    // packages/core/secrets/types.ts:SECRET_NAME_RE -- otherwise the
    // documented fallback is unreachable via `ark secrets set`.
    const r = await discoverAnthropicCredentials({
      env: {},
      readSecret: async (name) => (name === "SKILLHUB_ANTHROPIC_TOKEN" ? "sk-from-secrets" : null),
    });
    expect(r).toEqual({
      token: "sk-from-secrets",
      source: "ark-secret",
      kind: "api-key",
      sourceDetail: "SKILLHUB_ANTHROPIC_TOKEN",
    });
  });

  // Regression: the default secret name MUST satisfy `SECRET_NAME_RE`
  // (`[A-Z0-9_]+`) -- otherwise `ark secrets set <default>` rejects the
  // name and the documented fallback is unreachable in practice.
  it("default secret name matches the secret-store name regex", async () => {
    const SECRET_NAME_RE = /^[A-Z0-9_]+$/;
    let observedName: string | null = null;
    await discoverAnthropicCredentials({
      env: {},
      readSecret: async (name) => {
        observedName = name;
        return null;
      },
    }).catch(() => undefined);
    expect(observedName).not.toBeNull();
    expect(SECRET_NAME_RE.test(observedName!)).toBe(true);
  });

  it("respects a custom secretName", async () => {
    const r = await discoverAnthropicCredentials({
      env: {},
      secretName: "team-merge-key",
      readSecret: async (name) => (name === "team-merge-key" ? "sk-team" : null),
    });
    expect(r.source).toBe("ark-secret");
    expect(r.sourceDetail).toBe("team-merge-key");
    expect(r.token).toBe("sk-team");
  });

  it("env beats secrets (env is checked first)", async () => {
    const r = await discoverAnthropicCredentials({
      env: { ANTHROPIC_API_KEY: "from-env" },
      readSecret: async () => "from-secrets",
    });
    expect(r.source).toBe("env-api-key");
    expect(r.token).toBe("from-env");
  });

  it("OAuth env beats secrets", async () => {
    const r = await discoverAnthropicCredentials({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "from-oauth" },
      readSecret: async () => "from-secrets",
    });
    expect(r.source).toBe("env-oauth-token");
    expect(r.token).toBe("from-oauth");
  });
});

describe("discoverAnthropicCredentials — failure paths", () => {
  it("throws NoCredentialsError when nothing is found", async () => {
    await expect(discoverAnthropicCredentials({ env: {} })).rejects.toThrow(NoCredentialsError);
  });

  it("error message names every fix path so the user knows what to do", async () => {
    let err: Error | undefined;
    try {
      await discoverAnthropicCredentials({ env: {} });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    const msg = err!.message;
    expect(msg).toContain("ANTHROPIC_API_KEY");
    expect(msg).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(msg).toContain("ark secrets set");
    expect(msg).toContain("--no-merge");
  });

  it("notes 'skipped: no daemon' when readSecret was not supplied", async () => {
    let err: Error | undefined;
    try {
      await discoverAnthropicCredentials({ env: {} });
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).toContain("skipped: no daemon");
  });

  it("notes 'not set' when readSecret returns null", async () => {
    let err: Error | undefined;
    try {
      await discoverAnthropicCredentials({ env: {}, readSecret: async () => null });
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).toContain("not set");
  });

  it("treats whitespace-only secret value as absent", async () => {
    await expect(discoverAnthropicCredentials({ env: {}, readSecret: async () => "   " })).rejects.toThrow(
      NoCredentialsError,
    );
  });

  it("treats whitespace-only OAuth env value as absent", async () => {
    await expect(discoverAnthropicCredentials({ env: { CLAUDE_CODE_OAUTH_TOKEN: "   " } })).rejects.toThrow(
      NoCredentialsError,
    );
  });
});
