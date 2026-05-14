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
      // Accept both standard (RFC 4648 sec 4) and URL-safe (sec 5) base64
      // alphabets. Operators rotating keys with tools that emit URL-safe
      // output -- e.g. `openssl rand -base64 32 | tr '+/' '-_'` or several
      // Node-native helpers -- otherwise hit a spurious "not valid base64"
      // because Buffer.from happily decodes URL-safe but always re-encodes
      // as standard, breaking the roundtrip-equality check below.
      const standard = value.replace(/-/g, "+").replace(/_/g, "/");
      decoded = Buffer.from(standard, "base64");
      // Buffer.from is permissive about non-base64 input. Re-encode and
      // require equality to catch garbage that decoded to partial bytes.
      if (decoded.toString("base64").replace(/=+$/, "") !== standard.replace(/=+$/, "")) {
        throw new Error("not valid base64");
      }
    } catch (cause: any) {
      throw new KekLoadError(id, "SSM Parameter Value is not valid base64", cause);
    }

    if (decoded.length !== 32) {
      const wrongLen = decoded.length;
      // Zero the decoded buffer immediately so we don't dwell on the bytes.
      decoded.fill(0);
      throw new KekLoadError(id, `decoded KEK must be exactly 32 bytes, got ${wrongLen}`);
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
