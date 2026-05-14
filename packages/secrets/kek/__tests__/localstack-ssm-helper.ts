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
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
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
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-p",
      "4566",
      "-e",
      "SERVICES=ssm,kms",
      "-e",
      "DEBUG=0",
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
    } catch {
      /* best-effort */
    }
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
          "docker",
          "inspect",
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
