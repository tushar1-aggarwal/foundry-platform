# SSM-backed KEK Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `KekBackend` interface in the new `packages/secrets/` folder and ship `SsmKekBackend` as its first implementation, wired into `AppContext.boot()` so arkd fails fast if the SSM-stored master KEK can't be loaded.

**Architecture:** A thin `KekBackend` interface returns a `LoadedKek { material: SecureBuffer, version, describe() }`. `SsmKekBackend` reads a base64-encoded 32-byte SecureString parameter via `ssm:GetParameter WithDecryption=true`. A `loadMasterKey(config)` factory selects the backend from env config (`ARK_KEK_BACKEND=ssm` only in v1) and is invoked once during `AppContext.boot()`, eagerly so misconfigured deployments fail at startup.

**Tech Stack:** TypeScript (ES modules, `.js` extensions), Bun (runtime + `bun:test`), `@aws-sdk/client-ssm` (already a root dependency), LocalStack via existing `localstack-helper.ts` pattern.

**Source specs:**
- `docs/superpowers/specs/2026-05-14-ssm-kek-backend.md` (authoritative addendum -- supersedes D5/D20)
- `docs/superpowers/specs/2026-05-13-hierarchical-secrets-design.md` (parent spec; rest of design unchanged)

**Scope discipline:** This plan delivers the KEK seam only. Per-tenant DEK, cipher, resolver, audit, HTTP routes, CLI, dispatch integration -- all later plans. Do not pull them in here.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/secrets/index.ts` | Public re-exports from the `secrets` package (just KEK pieces for now) |
| `packages/secrets/kek/memory.ts` | `SecureBuffer` -- 32-byte off-heap buffer with `dispose()` that zero-fills |
| `packages/secrets/kek/backend.ts` | `KekBackend` interface, `LoadedKek` result type, `KekLoadError` class |
| `packages/secrets/kek/ssm.ts` | `SsmKekBackend` -- single `GetParameter` call, base64 decode, validate 32 bytes |
| `packages/secrets/kek/load.ts` | `KekConfig` type, `selectKekBackend(c)`, `loadMasterKey(c)` factory |
| `packages/secrets/kek/__tests__/memory.test.ts` | SecureBuffer unit tests |
| `packages/secrets/kek/__tests__/ssm.test.ts` | SsmKekBackend with mocked SSMClient |
| `packages/secrets/kek/__tests__/ssm.localstack.test.ts` | LocalStack-backed integration |
| `packages/secrets/kek/__tests__/load.test.ts` | Factory + env-config selection |
| `packages/secrets/kek/__tests__/localstack-ssm-helper.ts` | LocalStack helper extended for SSM service |
| `packages/core/app.ts` (modify) | Wire `loadMasterKey()` into `AppContext.boot()` and the DI container |
| `packages/core/config.ts` (modify, may already exist) | Add `kek: KekConfig` parsing from env |
| `packages/arkd/__tests__/kek-boot.test.ts` | Smoke test: arkd boots with stub backend; fails clean without one |

---

## Task 1: Scaffold the secrets package

**Files:**
- Create: `packages/secrets/index.ts`
- Create: `packages/secrets/kek/.gitkeep` (placeholder so the folder commits even before code)

- [ ] **Step 1: Create the package folder**

```bash
mkdir -p packages/secrets/kek/__tests__
```

Create `packages/secrets/index.ts` with no exports yet -- the public surface gets populated as each backing file lands. Empty surface keeps `bunx tsc` honest at every commit.

```ts
/**
 * @ark/secrets -- envelope encryption, KEK custody, tenant DEK management,
 * per-secret cipher, resolver. v1 ships the KEK seam only.
 *
 * See docs/superpowers/specs/2026-05-13-hierarchical-secrets-design.md and
 * docs/superpowers/specs/2026-05-14-ssm-kek-backend.md.
 *
 * Public exports are added as each module lands (see plan tasks 2-5).
 */
export {};
```

- [ ] **Step 2: Verify tsc accepts the new file**

Run: `bunx tsc --noEmit`
Expected: PASS (zero errors).

- [ ] **Step 3: Commit**

```bash
git add packages/secrets/index.ts
git commit -m "feat(secrets): scaffold packages/secrets folder for KEK module"
```

Note: each subsequent task (2 through 5) appends its module's exports to `packages/secrets/index.ts` in the same commit that lands the module. By Task 5 the full surface is:

```ts
export type { KekBackend, LoadedKek } from "./kek/backend.js";
export { KekLoadError } from "./kek/backend.js";
export { SecureBuffer } from "./kek/memory.js";
export type { KekConfig } from "./kek/load.js";
export { loadMasterKey, selectKekBackend, parseKekConfigFromEnv } from "./kek/load.js";
```

---

## Task 2: SecureBuffer

**Files:**
- Create: `packages/secrets/kek/memory.ts`
- Test: `packages/secrets/kek/__tests__/memory.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/secrets/kek/__tests__/memory.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { SecureBuffer } from "../memory.js";

describe("SecureBuffer", () => {
  it("wraps exactly 32 bytes", () => {
    const buf = new SecureBuffer(new Uint8Array(32).fill(7));
    expect(buf.byteLength).toBe(32);
    expect(buf.bytes()[0]).toBe(7);
    expect(buf.bytes()[31]).toBe(7);
  });

  it("rejects inputs of the wrong length", () => {
    expect(() => new SecureBuffer(new Uint8Array(16))).toThrow(/32/);
    expect(() => new SecureBuffer(new Uint8Array(33))).toThrow(/32/);
    expect(() => new SecureBuffer(new Uint8Array(0))).toThrow(/32/);
  });

  it("copies input bytes (caller can zero their source without affecting us)", () => {
    const src = new Uint8Array(32).fill(9);
    const buf = new SecureBuffer(src);
    src.fill(0);
    expect(buf.bytes()[0]).toBe(9);
  });

  it("dispose() zero-fills the buffer", () => {
    const buf = new SecureBuffer(new Uint8Array(32).fill(0xff));
    buf.dispose();
    const zero = Buffer.alloc(32);
    expect(Buffer.from(buf.bytes()).equals(zero)).toBe(true);
  });

  it("double-dispose is a no-op", () => {
    const buf = new SecureBuffer(new Uint8Array(32).fill(1));
    buf.dispose();
    expect(() => buf.dispose()).not.toThrow();
  });

  it("bytes() after dispose returns zero-filled view (no throw)", () => {
    // Rationale: callers should not rely on post-dispose reads, but they
    // must not crash the process if something stale tries.
    const buf = new SecureBuffer(new Uint8Array(32).fill(1));
    buf.dispose();
    expect(buf.bytes().every((b) => b === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `bun test packages/secrets/kek/__tests__/memory.test.ts`
Expected: FAIL with module-not-found for `../memory.js`.

- [ ] **Step 3: Implement SecureBuffer**

Create `packages/secrets/kek/memory.ts`:

```ts
/**
 * SecureBuffer -- 32-byte buffer for key material with zero-on-dispose.
 *
 * Harm reduction, not proof: V8 may copy bytes around the heap and we
 * cannot intercept GC. This implementation (a) refuses to materialize as
 * a string (no V8 string interning), (b) zero-fills the underlying memory
 * on dispose(), and (c) survives the caller mutating their input array.
 * Use it for the master KEK and unwrapped tenant DEKs only.
 */
export class SecureBuffer {
  private readonly _buf: Uint8Array;
  private _disposed = false;

  constructor(input: Uint8Array) {
    if (input.length !== 32) {
      throw new Error(`SecureBuffer requires exactly 32 bytes, got ${input.length}`);
    }
    // Copy so caller can zero their own source without affecting us.
    this._buf = new Uint8Array(32);
    this._buf.set(input);
  }

  get byteLength(): number {
    return 32;
  }

  /** Read-only view of the bytes. Post-dispose, returns zeros. */
  bytes(): Uint8Array {
    return this._buf;
  }

  /** Zero-fill in place. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._buf.fill(0);
    this._disposed = true;
  }
}
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `bun test packages/secrets/kek/__tests__/memory.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/secrets/kek/memory.ts packages/secrets/kek/__tests__/memory.test.ts
git commit -m "feat(secrets): SecureBuffer with zero-on-dispose for 32-byte key material"
```

---

## Task 3: KekBackend interface + error type

**Files:**
- Create: `packages/secrets/kek/backend.ts`

(No test file for this task -- pure type declarations and a one-line error subclass. The contract is exercised by `ssm.test.ts` in Task 4.)

- [ ] **Step 1: Write the interface and error**

Create `packages/secrets/kek/backend.ts`:

```ts
import type { SecureBuffer } from "./memory.js";

/**
 * Result of a successful KEK load.
 *
 * `material` is a SecureBuffer wrapping the 32 raw KEK bytes. Caller MUST
 * call `material.dispose()` during shutdown.
 *
 * `version` is the integer the operator considers "current". For SSM-backed
 * loads this is the SSM parameter Version (so SSM is the source of truth for
 * what `tenant_deks.kek_version` should record when wrapping DEKs).
 *
 * `describe()` returns a redacted identity string for startup logs and audit.
 * MUST NOT include any byte of the key material.
 */
export interface LoadedKek {
  material: SecureBuffer;
  version: number;
  describe(): string;
}

export interface KekBackend {
  /**
   * Load the master KEK. Implementations MUST fail loudly on any error
   * (missing parameter, IAM denied, wrong length, decode failure) by
   * throwing KekLoadError. Implementations MUST NOT log or include any
   * byte of the key material in error messages.
   */
  load(): Promise<LoadedKek>;
  /** Redacted backend identity for startup logs + audit. Never bytes. */
  describe(): string;
}

/**
 * Thrown for any KEK load failure. Message format:
 *   "KEK load failed via <backend>: <reason>"
 * NEVER include key bytes (partial or otherwise) in the message.
 */
export class KekLoadError extends Error {
  constructor(backend: string, reason: string, public readonly cause?: unknown) {
    super(`KEK load failed via ${backend}: ${reason}`);
    this.name = "KekLoadError";
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/secrets/kek/backend.ts
git commit -m "feat(secrets): KekBackend interface, LoadedKek result, KekLoadError"
```

---

## Task 4: SsmKekBackend with mocked SSM client

**Files:**
- Create: `packages/secrets/kek/ssm.ts`
- Test: `packages/secrets/kek/__tests__/ssm.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/secrets/kek/__tests__/ssm.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { SsmKekBackend } from "../ssm.js";
import { KekLoadError } from "../backend.js";

type Call = { command: string; input: Record<string, unknown> };

class MockSsmClient {
  calls: Call[] = [];
  responder: ((input: any) => any) | null = null;
  async send(command: any): Promise<any> {
    const name = command?.constructor?.name ?? "Unknown";
    const input = command?.input ?? {};
    this.calls.push({ command: name, input });
    if (command instanceof GetParameterCommand) {
      if (!this.responder) throw new Error("MockSsmClient: no responder set");
      return this.responder(input);
    }
    throw new Error(`MockSsmClient: no handler for ${name}`);
  }
}

const b64of32 = (fill: number): string =>
  Buffer.from(new Uint8Array(32).fill(fill)).toString("base64");

let client: MockSsmClient;
beforeEach(() => {
  client = new MockSsmClient();
});

describe("SsmKekBackend", () => {
  it("calls GetParameter with WithDecryption=true and the configured name", async () => {
    client.responder = () => ({ Parameter: { Value: b64of32(7), Version: 4 } });
    const backend = new SsmKekBackend({
      parameter: "/ark/prod/master-kek",
      region: "us-east-1",
      client: client as any,
    });
    const loaded = await backend.load();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].command).toBe("GetParameterCommand");
    expect(client.calls[0].input).toMatchObject({
      Name: "/ark/prod/master-kek",
      WithDecryption: true,
    });
    expect(loaded.material.byteLength).toBe(32);
    expect(loaded.material.bytes()[0]).toBe(7);
    expect(loaded.version).toBe(4);
    expect(loaded.describe()).toBe("ssm:/ark/prod/master-kek@v4");
  });

  it("describe() before load uses version 0 placeholder", () => {
    const backend = new SsmKekBackend({ parameter: "/ark/prod/master-kek", client: client as any });
    expect(backend.describe()).toBe("ssm:/ark/prod/master-kek");
  });

  it("defaults version to 1 if SSM does not report one", async () => {
    client.responder = () => ({ Parameter: { Value: b64of32(1) } });
    const backend = new SsmKekBackend({ parameter: "/x", client: client as any });
    const loaded = await backend.load();
    expect(loaded.version).toBe(1);
  });

  it("rejects when Parameter is undefined", async () => {
    client.responder = () => ({ Parameter: undefined });
    const backend = new SsmKekBackend({ parameter: "/missing", client: client as any });
    await expect(backend.load()).rejects.toThrow(KekLoadError);
    await expect(backend.load()).rejects.toThrow(/missing/i);
  });

  it("rejects when Value is undefined or empty", async () => {
    client.responder = () => ({ Parameter: { Value: undefined } });
    const backend = new SsmKekBackend({ parameter: "/x", client: client as any });
    await expect(backend.load()).rejects.toThrow(KekLoadError);
  });

  it("rejects non-base64 Value", async () => {
    client.responder = () => ({ Parameter: { Value: "not-base64-!!!" } });
    const backend = new SsmKekBackend({ parameter: "/x", client: client as any });
    await expect(backend.load()).rejects.toThrow(/base64|decode/i);
  });

  it("rejects when decoded length is not 32", async () => {
    const shortValue = Buffer.from(new Uint8Array(16)).toString("base64");
    client.responder = () => ({ Parameter: { Value: shortValue } });
    const backend = new SsmKekBackend({ parameter: "/x", client: client as any });
    await expect(backend.load()).rejects.toThrow(/32/);
  });

  it("wraps SDK errors in KekLoadError with the AWS error code", async () => {
    client.responder = () => {
      const err: any = new Error("User: arn:aws:... is not authorized");
      err.name = "AccessDeniedException";
      err.$metadata = { httpStatusCode: 400 };
      throw err;
    };
    const backend = new SsmKekBackend({ parameter: "/x", client: client as any });
    let caught: any;
    try {
      await backend.load();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KekLoadError);
    expect(caught.message).toMatch(/AccessDeniedException/);
    expect(caught.cause).toBeDefined();
  });

  it("length-mismatch error never contains the decoded bytes", async () => {
    // Drive the length-mismatch branch with a recognizable byte pattern; if
    // the formatter ever interpolates the buffer, this assertion fails.
    const recognizable = Buffer.from(new Uint8Array(8).fill(0xab)).toString("base64");
    client.responder = () => ({ Parameter: { Value: recognizable } });
    const backend = new SsmKekBackend({ parameter: "/x", client: client as any });
    try {
      await backend.load();
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e).toBeInstanceOf(KekLoadError);
      expect(String(e.message)).not.toContain("ab");
      expect(String(e.message)).not.toContain("0xab");
      expect(String(e.message)).not.toContain(recognizable);
    }
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `bun test packages/secrets/kek/__tests__/ssm.test.ts`
Expected: FAIL (module `../ssm.js` not found).

- [ ] **Step 3: Implement SsmKekBackend**

Create `packages/secrets/kek/ssm.ts`:

```ts
import type { SSMClient } from "@aws-sdk/client-ssm";
import { SecureBuffer } from "./memory.js";
import { KekLoadError, type KekBackend, type LoadedKek } from "./backend.js";

export interface SsmKekBackendConfig {
  /** Parameter name or full ARN. Required. */
  parameter: string;
  /** AWS region. Falls back to the AWS SDK default chain when unset. */
  region?: string;
  /** Optional endpoint override (LocalStack tests, VPC endpoints). */
  endpoint?: string;
  /** Test hook: inject a pre-built SSMClient. Production code leaves this unset. */
  client?: SSMClient;
}

export class SsmKekBackend implements KekBackend {
  constructor(private readonly config: SsmKekBackendConfig) {
    if (!config.parameter || typeof config.parameter !== "string") {
      throw new Error("SsmKekBackend: 'parameter' is required");
    }
  }

  describe(): string {
    return `ssm:${this.config.parameter}`;
  }

  async load(): Promise<LoadedKek> {
    const id = this.describe();
    const client = await this.getClient();
    const { GetParameterCommand } = await import("@aws-sdk/client-ssm");

    let response: any;
    try {
      response = await client.send(
        new GetParameterCommand({
          Name: this.config.parameter,
          WithDecryption: true,
        }),
      );
    } catch (cause: any) {
      const code = cause?.name ?? "UnknownAwsError";
      throw new KekLoadError(id, `SSM GetParameter failed (${code})`, cause);
    }

    const param = response?.Parameter;
    if (!param) {
      throw new KekLoadError(id, "SSM returned no Parameter (missing or filtered)");
    }

    const value: string | undefined = param.Value;
    if (typeof value !== "string" || value.length === 0) {
      throw new KekLoadError(id, "SSM Parameter Value is empty");
    }

    let decoded: Buffer;
    try {
      decoded = Buffer.from(value, "base64");
      // Buffer.from is permissive about non-base64 input. Re-encode and
      // require equality to catch garbage.
      if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
        throw new Error("not valid base64");
      }
    } catch (cause: any) {
      throw new KekLoadError(id, "SSM Parameter Value is not valid base64", cause);
    }

    if (decoded.length !== 32) {
      throw new KekLoadError(
        id,
        `decoded KEK must be exactly 32 bytes, got ${decoded.length}`,
      );
    }

    const material = new SecureBuffer(new Uint8Array(decoded));
    // Zero-fill the intermediate Buffer to reduce dwell time.
    decoded.fill(0);

    const version = typeof param.Version === "number" && param.Version > 0 ? param.Version : 1;

    return {
      material,
      version,
      describe: () => `${id}@v${version}`,
    };
  }

  private async getClient(): Promise<SSMClient> {
    if (this.config.client) return this.config.client;
    const { SSMClient: Ctor } = await import("@aws-sdk/client-ssm");
    const opts: any = {};
    if (this.config.region) opts.region = this.config.region;
    if (this.config.endpoint) opts.endpoint = this.config.endpoint;
    return new Ctor(opts);
  }
}
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `bun test packages/secrets/kek/__tests__/ssm.test.ts`
Expected: PASS, all cases above. If the "error messages never contain decoded bytes" test fails, the formatter is leaking; fix by removing any string interpolation of `decoded` or `value` in error messages.

- [ ] **Step 5: Commit**

```bash
git add packages/secrets/kek/ssm.ts packages/secrets/kek/__tests__/ssm.test.ts
git commit -m "feat(secrets): SsmKekBackend reads base64 32-byte KEK from SSM SecureString"
```

---

## Task 5: Loader factory + env-config parsing

**Files:**
- Create: `packages/secrets/kek/load.ts`
- Test: `packages/secrets/kek/__tests__/load.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/secrets/kek/__tests__/load.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { selectKekBackend, type KekConfig } from "../load.js";
import { SsmKekBackend } from "../ssm.js";

describe("selectKekBackend", () => {
  it("returns SsmKekBackend when backend=ssm and parameter set", () => {
    const cfg: KekConfig = { backend: "ssm", ssm: { parameter: "/ark/prod/k" } };
    const backend = selectKekBackend(cfg);
    expect(backend).toBeInstanceOf(SsmKekBackend);
    expect(backend.describe()).toBe("ssm:/ark/prod/k");
  });

  it("rejects backend=ssm without ssm.parameter", () => {
    expect(() => selectKekBackend({ backend: "ssm" } as any)).toThrow(/parameter/i);
    expect(() => selectKekBackend({ backend: "ssm", ssm: { parameter: "" } } as any)).toThrow(/parameter/i);
  });

  it("rejects unsupported backend values", () => {
    expect(() => selectKekBackend({ backend: "env" } as any)).toThrow(/supported.*ssm/i);
    expect(() => selectKekBackend({ backend: "vault" } as any)).toThrow(/supported.*ssm/i);
    expect(() => selectKekBackend({} as any)).toThrow(/supported.*ssm/i);
  });
});

describe("KekConfig env parsing", () => {
  // Tested indirectly via parseKekConfigFromEnv in load.ts
  it("parses ARK_KEK_BACKEND=ssm + ARK_KEK_SSM_PARAMETER", async () => {
    const { parseKekConfigFromEnv } = await import("../load.js");
    const cfg = parseKekConfigFromEnv({
      ARK_KEK_BACKEND: "ssm",
      ARK_KEK_SSM_PARAMETER: "/ark/prod/master-kek",
      ARK_KEK_SSM_REGION: "us-east-1",
    });
    expect(cfg).toEqual({
      backend: "ssm",
      ssm: { parameter: "/ark/prod/master-kek", region: "us-east-1" },
    });
  });

  it("throws when ARK_KEK_BACKEND missing", async () => {
    const { parseKekConfigFromEnv } = await import("../load.js");
    expect(() => parseKekConfigFromEnv({})).toThrow(/ARK_KEK_BACKEND/);
  });

  it("throws when ARK_KEK_BACKEND=ssm but parameter missing", async () => {
    const { parseKekConfigFromEnv } = await import("../load.js");
    expect(() => parseKekConfigFromEnv({ ARK_KEK_BACKEND: "ssm" })).toThrow(/ARK_KEK_SSM_PARAMETER/);
  });

  it("warns (but proceeds) when legacy ARK_MASTER_KEY is set", async () => {
    const { parseKekConfigFromEnv } = await import("../load.js");
    const warnings: string[] = [];
    const cfg = parseKekConfigFromEnv(
      {
        ARK_KEK_BACKEND: "ssm",
        ARK_KEK_SSM_PARAMETER: "/x",
        ARK_MASTER_KEY: "anything",
      },
      (msg) => warnings.push(msg),
    );
    expect(cfg.backend).toBe("ssm");
    expect(warnings.join("\n")).toMatch(/ARK_MASTER_KEY.*ignor/i);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `bun test packages/secrets/kek/__tests__/load.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the loader**

Create `packages/secrets/kek/load.ts`:

```ts
import type { KekBackend, LoadedKek } from "./backend.js";
import { SsmKekBackend } from "./ssm.js";

export interface KekConfig {
  /** v1 supports only "ssm". */
  backend: "ssm";
  ssm?: {
    /** SSM parameter name or full ARN. Required when backend=ssm. */
    parameter: string;
    /** AWS region. Falls back to SDK default chain if unset. */
    region?: string;
    /** Optional endpoint override (LocalStack, VPC endpoints). */
    endpoint?: string;
  };
}

const SUPPORTED = ["ssm"] as const;

export function selectKekBackend(cfg: KekConfig): KekBackend {
  if (!cfg || !SUPPORTED.includes(cfg.backend as any)) {
    throw new Error(
      `KEK backend not supported: got ${JSON.stringify(cfg?.backend)}, supported: [${SUPPORTED.join(", ")}]`,
    );
  }
  if (cfg.backend === "ssm") {
    const param = cfg.ssm?.parameter;
    if (!param || typeof param !== "string") {
      throw new Error("KEK backend 'ssm' requires ssm.parameter (non-empty string)");
    }
    return new SsmKekBackend({
      parameter: param,
      region: cfg.ssm?.region,
      endpoint: cfg.ssm?.endpoint,
    });
  }
  // Exhaustive guard -- unreachable because of SUPPORTED check above.
  throw new Error(`unreachable: unhandled KEK backend ${cfg.backend}`);
}

export async function loadMasterKey(cfg: KekConfig): Promise<LoadedKek> {
  return selectKekBackend(cfg).load();
}

/**
 * Parse a KekConfig out of a process-env-like object. Pure function so
 * tests can drive it without mutating process.env.
 *
 * @param env environment map (typically process.env)
 * @param warn optional warning sink; defaults to console.warn
 */
export function parseKekConfigFromEnv(
  env: Record<string, string | undefined>,
  warn: (msg: string) => void = (m) => console.warn(m),
): KekConfig {
  const backend = env.ARK_KEK_BACKEND;
  if (!backend) {
    throw new Error(
      `ARK_KEK_BACKEND is required (supported: ${SUPPORTED.join(", ")})`,
    );
  }
  if (!SUPPORTED.includes(backend as any)) {
    throw new Error(
      `ARK_KEK_BACKEND=${backend} not supported (supported: ${SUPPORTED.join(", ")})`,
    );
  }
  if (env.ARK_MASTER_KEY) {
    warn(
      "ARK_MASTER_KEY is set but EnvKekBackend is not shipped in v1; ignoring. " +
        "Remove the env var to silence this warning.",
    );
  }
  if (backend === "ssm") {
    const parameter = env.ARK_KEK_SSM_PARAMETER;
    if (!parameter) {
      throw new Error(
        "ARK_KEK_BACKEND=ssm requires ARK_KEK_SSM_PARAMETER (SSM parameter name or ARN)",
      );
    }
    return {
      backend: "ssm",
      ssm: {
        parameter,
        region: env.ARK_KEK_SSM_REGION,
        endpoint: env.ARK_KEK_SSM_ENDPOINT,
      },
    };
  }
  throw new Error(`unreachable: unhandled ARK_KEK_BACKEND=${backend}`);
}
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `bun test packages/secrets/kek/__tests__/load.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Finalize `packages/secrets/index.ts` public surface**

Replace the contents of `packages/secrets/index.ts` with:

```ts
/**
 * @ark/secrets -- envelope encryption, KEK custody, tenant DEK management,
 * per-secret cipher, resolver. v1 ships the KEK seam only.
 *
 * See docs/superpowers/specs/2026-05-13-hierarchical-secrets-design.md and
 * docs/superpowers/specs/2026-05-14-ssm-kek-backend.md.
 */
export type { KekBackend, LoadedKek } from "./kek/backend.js";
export { KekLoadError } from "./kek/backend.js";
export { SecureBuffer } from "./kek/memory.js";
export type { KekConfig } from "./kek/load.js";
export { loadMasterKey, selectKekBackend, parseKekConfigFromEnv } from "./kek/load.js";
```

- [ ] **Step 6: Run the full secrets package suite**

Run: `bun test packages/secrets/`
Expected: PASS, all 3 test files green (memory, ssm, load). The localstack file is skipped without docker -- that's fine.

- [ ] **Step 7: Commit**

```bash
git add packages/secrets/kek/load.ts packages/secrets/kek/__tests__/load.test.ts packages/secrets/index.ts
git commit -m "feat(secrets): loadMasterKey + parseKekConfigFromEnv with SSM-only v1 surface"
```

---

## Task 6: LocalStack helper extended for SSM

**Files:**
- Create: `packages/secrets/kek/__tests__/localstack-ssm-helper.ts`

Why a new helper instead of extending `packages/core/storage/__tests__/localstack-helper.ts`: that helper is S3-specific (creates a bucket, returns `bucket` in its handle). SSM is different enough that copy-and-adapt keeps each helper focused. The shared shape (`Bun.spawn`, port discovery, health polling, image pin) is intentionally duplicated; once a third helper appears, factor a common `startLocalStack(services)` underneath.

- [ ] **Step 1: Create the helper**

Create `packages/secrets/kek/__tests__/localstack-ssm-helper.ts`:

```ts
/**
 * LocalStack helper -- starts a disposable LocalStack container with
 * SERVICES=ssm,kms so `SsmKekBackend` can be exercised against a live
 * (local) SSM API. Cloned from
 * packages/core/storage/__tests__/localstack-helper.ts and adapted for SSM.
 */
import { randomBytes } from "crypto";

export class DockerUnavailableError extends Error {
  constructor(cause?: string) {
    super(`docker is not available on this host${cause ? `: ${cause}` : ""}`);
    this.name = "DockerUnavailableError";
  }
}

export interface LocalStackSsmHandle {
  endpoint: string;
  container: string;
  stop: () => Promise<void>;
}

export const LOCALSTACK_IMAGE = "localstack/localstack:3.8";
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 200;

export async function isDockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn({ cmd: ["docker", "ps"], stdout: "pipe", stderr: "pipe" });
    const code = await Promise.race<number | "timeout">([
      proc.exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    if (code === "timeout") {
      try { proc.kill(); } catch { /* ignore */ }
      return false;
    }
    return code === 0;
  } catch {
    return false;
  }
}

export async function startLocalStackSsm(): Promise<LocalStackSsmHandle> {
  if (!(await isDockerAvailable())) throw new DockerUnavailableError();
  const container = `ark-localstack-ssm-${randomBytes(4).toString("hex")}`;

  const runProc = Bun.spawn({
    cmd: [
      "docker", "run", "-d", "--rm",
      "--name", container,
      "-p", "4566",
      "-e", "SERVICES=ssm,kms",
      "-e", "DEBUG=0",
      LOCALSTACK_IMAGE,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const runStdout = await new Response(runProc.stdout).text();
  const runStderr = await new Response(runProc.stderr).text();
  const runCode = await runProc.exited;
  if (runCode !== 0) {
    throw new Error(`failed to start LocalStack(ssm): exit ${runCode}\nstdout: ${runStdout}\nstderr: ${runStderr}`);
  }

  const stop = async (): Promise<void> => {
    try {
      const killProc = Bun.spawn({ cmd: ["docker", "rm", "-f", container], stdout: "pipe", stderr: "pipe" });
      await killProc.exited;
    } catch { /* best-effort */ }
  };

  try {
    const hostPort = await resolveMappedPort(container, 4566);
    const endpoint = `http://127.0.0.1:${hostPort}`;
    await waitForReady(endpoint, "ssm");
    return { endpoint, container, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

async function resolveMappedPort(container: string, containerPort: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const proc = Bun.spawn({
        cmd: [
          "docker", "inspect",
          "--format",
          `{{ (index (index .NetworkSettings.Ports "${containerPort}/tcp") 0).HostPort }}`,
          container,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = (await new Response(proc.stdout).text()).trim();
      const stderr = (await new Response(proc.stderr).text()).trim();
      const code = await proc.exited;
      if (code === 0 && stdout && stdout !== "<no value>") {
        const port = Number(stdout);
        if (Number.isFinite(port) && port > 0) return port;
      }
      lastErr = new Error(`docker inspect rc=${code} stdout=${stdout} stderr=${stderr}`);
    } catch (err) {
      lastErr = err as Error;
    }
    await Bun.sleep(HEALTH_POLL_MS);
  }
  throw new Error(`could not resolve host port for container ${container}: ${lastErr?.message ?? "timeout"}`);
}

async function waitForReady(endpoint: string, service: "ssm"): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint}/_localstack/health`);
      if (res.ok) {
        const body = (await res.json()) as { services?: Record<string, string> };
        const s = body.services?.[service];
        if (s === "running" || s === "available") return;
      }
      lastErr = new Error(`health status ${res.status}`);
    } catch (err) {
      lastErr = err as Error;
    }
    await Bun.sleep(HEALTH_POLL_MS);
  }
  throw new Error(`LocalStack ${service} did not report healthy within ${HEALTH_TIMEOUT_MS}ms: ${lastErr?.message ?? ""}`);
}

export function setLocalStackCredentials(): { restore: () => void } {
  const prev = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: process.env.AWS_REGION,
  };
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
  process.env.AWS_REGION = "us-east-1";
  return {
    restore: () => {
      if (prev.AWS_ACCESS_KEY_ID === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = prev.AWS_ACCESS_KEY_ID;
      if (prev.AWS_SECRET_ACCESS_KEY === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prev.AWS_SECRET_ACCESS_KEY;
      if (prev.AWS_REGION === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = prev.AWS_REGION;
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/secrets/kek/__tests__/localstack-ssm-helper.ts
git commit -m "test(secrets): LocalStack helper for SSM-backed integration tests"
```

---

## Task 7: SsmKekBackend LocalStack integration test

**Files:**
- Create: `packages/secrets/kek/__tests__/ssm.localstack.test.ts`

- [ ] **Step 1: Write the integration test**

Create `packages/secrets/kek/__tests__/ssm.localstack.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import { SsmKekBackend } from "../ssm.js";
import {
  startLocalStackSsm,
  isDockerAvailable,
  setLocalStackCredentials,
  type LocalStackSsmHandle,
} from "./localstack-ssm-helper.js";

const dockerOk = await isDockerAvailable();
const d = dockerOk ? describe : describe.skip;

d("SsmKekBackend (LocalStack)", () => {
  let ls: LocalStackSsmHandle;
  let restoreCreds: () => void;

  beforeAll(async () => {
    ls = await startLocalStackSsm();
    restoreCreds = setLocalStackCredentials().restore;
  });

  afterAll(async () => {
    restoreCreds?.();
    await ls?.stop();
  });

  it("loads a 32-byte KEK end-to-end via SSM SecureString", async () => {
    const paramName = "/ark/test/master-kek";
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = (i * 7) & 0xff;
    const b64 = Buffer.from(raw).toString("base64");

    // Put the parameter directly via the SDK pointed at LocalStack.
    const writer = new SSMClient({ endpoint: ls.endpoint, region: "us-east-1" });
    try {
      await writer.send(
        new PutParameterCommand({
          Name: paramName,
          Value: b64,
          Type: "SecureString",
          Overwrite: true,
        }),
      );
    } finally {
      writer.destroy();
    }

    const backend = new SsmKekBackend({
      parameter: paramName,
      region: "us-east-1",
      endpoint: ls.endpoint,
    });
    const loaded = await backend.load();
    expect(loaded.material.byteLength).toBe(32);
    expect(Array.from(loaded.material.bytes())).toEqual(Array.from(raw));
    expect(loaded.version).toBeGreaterThanOrEqual(1);
    expect(loaded.describe()).toMatch(/^ssm:\/ark\/test\/master-kek@v\d+$/);
    loaded.material.dispose();
  }, 60_000);

  it("fails with KekLoadError when the parameter does not exist", async () => {
    const backend = new SsmKekBackend({
      parameter: "/ark/test/does-not-exist",
      region: "us-east-1",
      endpoint: ls.endpoint,
    });
    await expect(backend.load()).rejects.toThrow(/SSM GetParameter failed/);
  }, 60_000);
});
```

- [ ] **Step 2: Run it (with docker)**

Run: `bun test packages/secrets/kek/__tests__/ssm.localstack.test.ts`
Expected: PASS when docker is running (2 tests). On hosts without docker, the suite reports as skipped (no failure).

- [ ] **Step 3: Commit**

```bash
git add packages/secrets/kek/__tests__/ssm.localstack.test.ts
git commit -m "test(secrets): SsmKekBackend LocalStack round-trip integration"
```

---

## Task 8: Wire `loadMasterKey()` into `AppContext.boot()`

**Files:**
- Modify: `packages/core/app.ts` (boot path)
- Modify: `packages/core/config.ts` (add `kek` field) -- inspect first; if config-builder lives elsewhere, modify the relevant file

### 8a. Locate and extend ArkConfig

- [ ] **Step 1: Find the config type**

Run: `grep -n "ArkConfig\b" packages/core/config.ts packages/core/app.ts | head`
Expected: identifies the canonical type declaration. Open the file at the matching line.

- [ ] **Step 2: Add `kek` to `ArkConfig`**

Locate the `ArkConfig` interface/type. Add an optional `kek?: KekConfig` field. Import the type at the top of the same file:

```ts
import type { KekConfig } from "../secrets/index.js"; // adjust the relative path; from packages/core/config.ts it is "../secrets/index.js"
```

If the file is `packages/core/config.ts`, the import becomes `"../secrets/index.js"`. Verify the relative path resolves before continuing.

- [ ] **Step 3: Extend the config builder to read env**

Find where `ArkConfig` is constructed from `process.env` (typically a `loadConfig()` or similar in `config.ts`). Add:

```ts
import { parseKekConfigFromEnv } from "../secrets/index.js";
// inside the config builder:
const kek = parseKekConfigFromEnv(process.env);
// ... assemble config with `kek` field set
```

If config construction has multiple sites (test config, production config), only wire the production / boot path here. Test code stubs `kek` explicitly in 8c.

### 8b. Eager load in `AppContext.boot()`

- [ ] **Step 4: Declare the field on `AppContext`**

In `packages/core/app.ts`, near the existing `_drizzle: DrizzleClient | null = null;` field declaration on `AppContext`, add:

```ts
private _loadedKek: import("../secrets/index.js").LoadedKek | null = null;

/** Loaded master KEK; populated during boot(). Throws if accessed pre-boot. */
get loadedKek(): import("../secrets/index.js").LoadedKek {
  if (!this._loadedKek) {
    throw new Error("AppContext.loadedKek accessed before boot() completed");
  }
  return this._loadedKek;
}
```

The public getter is what downstream code (and tests) read, avoiding `(app as any)._loadedKek` access.

- [ ] **Step 5: Add the boot step**

Open `packages/core/app.ts`. In `boot()` (around line 118), insert immediately after `await this._initSchema(db);` and before `await this._seedComputeTemplates(db);`:

```ts
// Load the master KEK before the container is built so a misconfigured
// deployment fails at boot rather than at first secret read.
if (this.options.stubKek) {
  // Test path: caller injected a pre-loaded KEK (see forTestAsync below).
  this._loadedKek = this.options.stubKek;
} else {
  const kekConfig = this.config.kek;
  if (!kekConfig) {
    throw new Error("AppContext.boot: config.kek is missing -- ARK_KEK_BACKEND is not configured");
  }
  const { loadMasterKey } = await import("../secrets/index.js");
  this._loadedKek = await loadMasterKey(kekConfig);
}
```

This goes **after** schema init (so log/audit tables exist if the loader ever writes to them) and **before** compute-template seeding (no dependency, but earlier-is-better for fail-fast).

- [ ] **Step 6: Register the LoadedKek in the DI container**

After `this._container = buildContainer({ app: this, ... });` (around line 137), append a registration that follows the existing `asValue` pattern visible at line 109:

```ts
this._container.register({
  loadedKek: asValue(this._loadedKek!),
});
```

Awilix `asValue` registrations are not lifecycle-managed (no `dispose`). The SecureBuffer is therefore disposed explicitly in `shutdown()` (Step 7), not through awilix.

- [ ] **Step 7: Shutdown disposal**

Open the `shutdown()` method. Add this immediately after `if (wasBooted) {` and before `await this._container.dispose()`:

```ts
this._loadedKek?.material.dispose();
this._loadedKek = null;
```

`SecureBuffer.dispose()` is idempotent (Task 2), so this is safe even if a future change adds a second dispose call.

### 8c. Test bypass and default stub

The `stubKek` option in `AppBootOptions` already exists in the boot logic from Step 5. Now wire it into the test factories.

- [ ] **Step 8: Add `stubKek` to `AppBootOptions`**

Open `packages/core/app.ts`. Find the `AppBootOptions` (or `AppOptions`) type definition and add:

```ts
/** Test hook: skip KEK loading and use this pre-loaded value instead. */
stubKek?: import("../secrets/index.js").LoadedKek;
```

- [ ] **Step 9: Default a stub KEK in `forTestAsync` (and `forTest`)**

In `AppContext.forTestAsync()` at `packages/core/app.ts:1042`, before constructing the AppContext, install a deterministic stub KEK if the caller hasn't supplied one:

```ts
// Inside forTestAsync, after config is built:
const options: AppOptions = { ...(arguments[1] ?? {}) };
if (!options.stubKek) {
  const { SecureBuffer } = await import("../secrets/index.js");
  const material = new SecureBuffer(new Uint8Array(32).fill(0xa5));
  options.stubKek = { material, version: 1, describe: () => "stub:forTestAsync@v1" };
}
return new AppContext(config, { ...TEST_OPTIONS, ...options });
```

Mirror in `forTest()` if it also boots an `AppContext`. The exact signature wiring depends on how `forTestAsync` already merges options -- read the function and follow the existing pattern; the load-bearing requirement is just that every test-constructed AppContext receives a `stubKek`.

- [ ] **Step 10: Run the core test suite**

Run: `bun test packages/core/`
Expected: PASS. If anything regresses, the most likely cause is a test that constructs `AppContext` directly (without `forTestAsync`) -- fix by routing through `forTestAsync` or by passing `stubKek` explicitly.

E2E or integration suites that boot a real `AppContext` outside `forTestAsync` (typically under `packages/e2e/`) will need `ARK_KEK_BACKEND=ssm` + a LocalStack-backed parameter. If any such test breaks, fix it by gating on docker availability and using `startLocalStackSsm` from Task 6. If the failure is in `make dev` flow (developer ergonomics, not a test), document the new env-var requirement in `CLAUDE.md` as a follow-up.

- [ ] **Step 11: Commit**

```bash
git add packages/core/app.ts packages/core/config.ts
git commit -m "feat(core): load master KEK during AppContext.boot via KekBackend"
```

---

## Task 9: arkd boot smoke test

**Files:**
- Create: `packages/arkd/__tests__/kek-boot.test.ts`

- [ ] **Step 1: Determine the import pattern**

Run: `grep -rn "import.*AppContext" packages/arkd/__tests__ packages/core/__tests__ 2>/dev/null | head -5`
Use whichever relative-path pattern the existing arkd or core tests use to import `AppContext`. The examples below use `"../../core/app.js"` -- adjust to match.

- [ ] **Step 2: Write the test**

Create `packages/arkd/__tests__/kek-boot.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { AppContext } from "../../core/app.js"; // adjust per Step 1
import { SecureBuffer } from "../../secrets/index.js";

describe("arkd boot -- KEK", () => {
  it("boots with the default stub KEK installed by forTestAsync", async () => {
    const app = await AppContext.forTestAsync();
    expect(app.phase).toBe("ready");
    // Reading via the public getter (added in Task 8 Step 4)
    const kek = app.loadedKek;
    expect(kek.material.byteLength).toBe(32);
    expect(kek.version).toBeGreaterThanOrEqual(1);
    await app.shutdown();
    expect(app.phase).toBe("stopped");
  }, 30_000);

  it("disposes the SecureBuffer on shutdown", async () => {
    const material = new SecureBuffer(new Uint8Array(32).fill(0x5a));
    const stubKek = { material, version: 7, describe: () => "stub:test@v7" };
    const app = await AppContext.forTestAsync(undefined, { stubKek } as any);
    expect(app.loadedKek.version).toBe(7);
    await app.shutdown();
    expect(material.bytes().every((b) => b === 0)).toBe(true);
  }, 30_000);

  it("fails to boot when config.kek is missing and no stub provided", async () => {
    // Construct a real AppContext bypassing forTestAsync's defaults.
    // Approach: borrow the config forTestAsync would have produced, then
    // null out kek and clear stubKek before booting.
    const ref = await AppContext.forTestAsync();
    const cfg: any = { ...ref.config, kek: undefined };
    await ref.shutdown();

    const app = new AppContext(cfg, {} as any);
    let caught: any = null;
    try {
      await app.boot();
    } catch (e) {
      caught = e;
    } finally {
      // Best-effort cleanup in case boot got partway.
      try { await app.shutdown(); } catch { /* ignore */ }
    }
    expect(caught).toBeTruthy();
    expect(String(caught.message)).toMatch(/ARK_KEK_BACKEND|kek/i);
  }, 30_000);
});
```

- [ ] **Step 2: Run it**

Run: `bun test packages/arkd/__tests__/kek-boot.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 3: Commit**

```bash
git add packages/arkd/__tests__/kek-boot.test.ts
git commit -m "test(arkd): smoke test that boot eager-loads KEK and dispose zeroes it"
```

---

## Task 10: Full suite + lint/format + final commit

- [ ] **Step 1: Run the full test suite**

Run: `make test`
Expected: PASS. If anything outside the new code regressed, the most likely cause is `AppContext.forTestAsync` not installing the stub KEK; fix there.

- [ ] **Step 2: Lint and format**

Run: `make format && make lint`
Expected: zero warnings, zero errors. CI rejects otherwise per `CLAUDE.md`.

- [ ] **Step 3: Final verification commit (if format/lint changed anything)**

```bash
git add -A
git diff --cached --quiet || git commit -m "chore(secrets): apply prettier + eslint to KEK module"
```

- [ ] **Step 4: Confirm branch state**

Run: `git log --oneline feature/secrets-management-revisions ^main | cat`
Expected: a clean stack of commits from Tasks 1-10 on top of the existing secrets-management-revisions branch.

---

## Acceptance criteria (work back from here)

- `bun test packages/secrets/` is green; covers SecureBuffer, KekBackend interface, SsmKekBackend mocked + LocalStack, loadMasterKey factory + env parsing.
- `make test` is green; existing `AppContext`-based tests pass without any test needing real AWS or LocalStack.
- `make format && make lint` is green.
- arkd refuses to boot if `ARK_KEK_BACKEND` is missing or `ARK_KEK_SSM_PARAMETER` is unset.
- arkd refuses to boot if the SSM parameter doesn't exist, returns a non-base64 value, or returns a value that decodes to ≠32 bytes -- and the error message contains the parameter name + AWS error code but never any byte of the (partial) material.
- Shutdown zero-fills the `SecureBuffer`.
- Setting `ARK_MASTER_KEY` does NOT cause boot to fail; it only emits a warning.
- New `KekBackend` interface is the only public seam: downstream features (tenant-DEK, cipher) consume `LoadedKek`, never the backend directly.

## Intentional deviations from the spec

- **`backend.contract.test.ts` is not created.** The addendum spec lists a small "contract suite parameterized over a `KekBackend`" alongside per-implementation tests. With only one concrete backend in v1, the contract is fully exercised by `ssm.test.ts` and a separate file would be ceremony. When a second backend lands, extract the shared assertions from `ssm.test.ts` into a contract file and reuse it -- track as a follow-up.

## Follow-ups (NOT in this plan)

Track separately; do not pull into this plan:

- Per-tenant DEK module (`tenant-dek.ts`) and `tenant_deks` table.
- AES-256-GCM cipher with AAD discipline (`cipher.ts`).
- KEK rotation tooling (`ark secrets rewrap-deks --from-old-key=...`).
- A `make bootstrap-kek-ssm` helper that wraps the operator workflow from the addendum spec.
- Updating `docs/architecture.md` and `docs/ark-brief.md` to reference the SSM-backed KEK posture.
