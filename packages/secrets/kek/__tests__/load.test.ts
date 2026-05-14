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

  it("includes endpoint when ARK_KEK_SSM_ENDPOINT is set", async () => {
    const { parseKekConfigFromEnv } = await import("../load.js");
    const cfg = parseKekConfigFromEnv({
      ARK_KEK_BACKEND: "ssm",
      ARK_KEK_SSM_PARAMETER: "/x",
      ARK_KEK_SSM_ENDPOINT: "http://localhost:4566",
    });
    expect(cfg.ssm?.endpoint).toBe("http://localhost:4566");
  });
});
