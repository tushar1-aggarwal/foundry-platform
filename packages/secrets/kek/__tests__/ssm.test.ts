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

const b64of32 = (fill: number): string => Buffer.from(new Uint8Array(32).fill(fill)).toString("base64");

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

  it("describe() before load uses parameter only (no version)", () => {
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

  it("accepts URL-safe base64 (RFC 4648 sec 5)", async () => {
    // 0xfb-filled 32 bytes produces both `+` and `/` in standard base64,
    // so the URL-safe-substituted form below exercises both replacements.
    // Operators rotating with `openssl rand -base64 32 | tr '+/' '-_'`
    // (and many language-native helpers) emit this shape.
    const standard = Buffer.from(new Uint8Array(32).fill(0xfb)).toString("base64");
    expect(standard).toMatch(/[+/]/); // sanity: the fixture actually contains the chars we're testing
    const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_");
    client.responder = () => ({ Parameter: { Value: urlSafe, Version: 2 } });
    const backend = new SsmKekBackend({ parameter: "/x", client: client as any });
    const loaded = await backend.load();
    expect(loaded.material.byteLength).toBe(32);
    expect(loaded.material.bytes()[0]).toBe(0xfb);
    expect(loaded.version).toBe(2);
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
