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
  }, 120_000);

  afterAll(async () => {
    restoreCreds?.();
    await ls?.stop();
  }, 30_000);

  it("loads a 32-byte KEK end-to-end via SSM SecureString", async () => {
    const paramName = "/ark/test/master-kek";
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = (i * 7) & 0xff;
    const b64 = Buffer.from(raw).toString("base64");

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
