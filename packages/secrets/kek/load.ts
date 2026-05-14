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
    throw new Error(`ARK_KEK_BACKEND is required (supported: ${SUPPORTED.join(", ")})`);
  }
  if (!SUPPORTED.includes(backend as any)) {
    throw new Error(`ARK_KEK_BACKEND=${backend} not supported (supported: ${SUPPORTED.join(", ")})`);
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
      throw new Error("ARK_KEK_BACKEND=ssm requires ARK_KEK_SSM_PARAMETER (SSM parameter name or ARN)");
    }
    const ssm: NonNullable<KekConfig["ssm"]> = { parameter };
    if (env.ARK_KEK_SSM_REGION) ssm.region = env.ARK_KEK_SSM_REGION;
    if (env.ARK_KEK_SSM_ENDPOINT) ssm.endpoint = env.ARK_KEK_SSM_ENDPOINT;
    return { backend: "ssm", ssm };
  }
  throw new Error(`unreachable: unhandled ARK_KEK_BACKEND=${backend}`);
}
