/**
 * Anthropic-credential discovery for `ark skills sync` (RFC §7).
 *
 * The CLI runs the 3-way LLM merge locally via the linked
 * `@anthropic-ai/claude-agent-sdk`. The SDK auto-selects its auth path
 * from `process.env`:
 *   - `ANTHROPIC_API_KEY`        -> direct Anthropic API
 *   - `CLAUDE_CODE_OAUTH_TOKEN`  -> Claude Code Max / claude.ai OAuth
 *     (the SDK reads this env var for Claude Code Max subscribers, who
 *     can run the merge without provisioning a separate API key).
 *
 * Discovery order (first hit wins):
 *   1. `ANTHROPIC_API_KEY` env             (direct API; most reliable)
 *   2. `CLAUDE_CODE_OAUTH_TOKEN` env       (Claude Code Max subscription)
 *   3. `ark secrets get <secretName>` (default name `SKILLHUB_ANTHROPIC_TOKEN`).
 *      The secret name matches `[A-Z0-9_]+` per the secret-store contract
 *      (`packages/core/secrets/types.ts:SECRET_NAME_RE`); a lowercase /
 *      hyphenated default would be unreachable through `ark secrets set`.
 *      The stored value is interpreted as an API key (ARK secrets are
 *      provisioned by operators, who supply API keys for service paths).
 *
 * Caller passes in a "secret reader" callback so this module doesn't
 * import the full ArkClient surface - keeps unit tests trivial. The
 * sync command supplies `(name) => arkClient.secretGet(name)` in
 * production.
 */

/** Discovery path that produced the credential. */
export type CredentialSource = "env-api-key" | "env-oauth-token" | "ark-secret";

/** Whether the token is an Anthropic API key or a Claude Code OAuth bearer. */
export type CredentialKind = "api-key" | "oauth-token";

export interface CredentialResolution {
  /** The token value to thread into the SDK. */
  token: string;
  /** Discovery path that resolved this token. */
  source: CredentialSource;
  /** Token-format kind: drives which env var the merge fn sets. */
  kind: CredentialKind;
  /** Which env var / secret name matched. */
  sourceDetail: string;
}

export class NoCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoCredentialsError";
  }
}

export interface DiscoverOpts {
  /**
   * Read one secret by name. Returns the value or `null` when absent.
   * Omit to skip the `ark secrets` fallback entirely (e.g. offline mode
   * where no daemon is available).
   */
  readSecret?: (name: string) => Promise<string | null>;
  /** Override the default ark-secrets key. Defaults to `SKILLHUB_ANTHROPIC_TOKEN`. */
  secretName?: string;
  /**
   * Override the env reader. Used by tests to feed deterministic env
   * vars without polluting `process.env`. Defaults to `process.env`.
   */
  env?: Record<string, string | undefined>;
}

export async function discoverAnthropicCredentials(opts: DiscoverOpts = {}): Promise<CredentialResolution> {
  const env = opts.env ?? process.env;
  const secretName = opts.secretName ?? "SKILLHUB_ANTHROPIC_TOKEN";

  const apiKey = trimmed(env.ANTHROPIC_API_KEY);
  if (apiKey) {
    return { token: apiKey, source: "env-api-key", kind: "api-key", sourceDetail: "ANTHROPIC_API_KEY" };
  }

  const oauthToken = trimmed(env.CLAUDE_CODE_OAUTH_TOKEN);
  if (oauthToken) {
    return {
      token: oauthToken,
      source: "env-oauth-token",
      kind: "oauth-token",
      sourceDetail: "CLAUDE_CODE_OAUTH_TOKEN",
    };
  }

  if (opts.readSecret) {
    const value = trimmed(await opts.readSecret(secretName));
    if (value) {
      return { token: value, source: "ark-secret", kind: "api-key", sourceDetail: secretName };
    }
  }

  throw new NoCredentialsError(
    [
      "no Anthropic credentials available for the client-side merge",
      "",
      "discovery checked:",
      "  - ANTHROPIC_API_KEY env var          (not set)",
      "  - CLAUDE_CODE_OAUTH_TOKEN env var    (not set)",
      `  - ark secrets get ${secretName}    (${opts.readSecret ? "not set" : "skipped: no daemon"})`,
      "",
      "fix one of:",
      "  - export ANTHROPIC_API_KEY=sk-ant-...        (one-shot for this shell)",
      "  - export CLAUDE_CODE_OAUTH_TOKEN=...         (Claude Code Max subscription)",
      `  - ark secrets set ${secretName} sk-ant-...   (persistent, ark-managed)`,
      "  - rerun with --no-merge                      (skip LLM merge; treat every conflict as requires_manual)",
    ].join("\n"),
  );
}

function trimmed(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}
