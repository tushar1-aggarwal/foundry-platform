/**
 * compute/create requires the two-axis `{compute, isolation}` form and
 * persists `compute_kind` / `isolation_kind`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { Router } from "../router.js";
import { registerResourceHandlers } from "../handlers/resource.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  router = new Router();
  registerResourceHandlers(router, app);
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(async () => {
  for (const c of await app.computes.list()) {
    if (c.name !== "local") await app.computes.delete(c.name);
  }
});

async function call(method: string, params: Record<string, unknown>): Promise<any> {
  const result = await router.dispatch({ jsonrpc: "2.0", id: 1, method, params });
  if ((result as any).error) throw new Error((result as any).error.message);
  return (result as any).result;
}

describe("compute/create (two-axis form)", async () => {
  it("persists compute_kind + isolation_kind", async () => {
    const { compute } = await call("compute/create", {
      name: "new-form-docker",
      compute: "local",
      isolation: "docker",
      config: {},
    });
    expect(compute.name).toBe("new-form-docker");
    expect(compute.compute_kind).toBe("local");
    expect(compute.isolation_kind).toBe("docker");
    expect(compute.provider).toBeUndefined();
  });

  it("accepts ec2 + devcontainer", async () => {
    const { compute } = await call("compute/create", {
      name: "new-form-ec2-dc",
      compute: "ec2",
      isolation: "devcontainer",
      config: { region: "us-east-1" },
    });
    expect(compute.compute_kind).toBe("ec2");
    expect(compute.isolation_kind).toBe("devcontainer");
  });

  it("rejects a create without compute + isolation", async () => {
    await expect(call("compute/create", { name: "no-axes", config: {} })).rejects.toThrow();
  });

  it("compute/read returns both axes", async () => {
    await call("compute/create", { name: "read-test", compute: "ec2", isolation: "docker", config: {} });
    const { compute } = await call("compute/read", { name: "read-test" });
    expect(compute.compute_kind).toBe("ec2");
    expect(compute.isolation_kind).toBe("docker");
    expect(compute.provider).toBeUndefined();
  });

  it("compute/kinds returns the registered compute list", async () => {
    const res = await call("compute/kinds", {});
    expect(Array.isArray(res.kinds)).toBe(true);
    expect(res.kinds).toContain("local");
  });

  it("runtime/kinds returns the registered isolation list", async () => {
    const res = await call("runtime/kinds", {});
    expect(Array.isArray(res.kinds)).toBe(true);
    expect(res.kinds).toContain("direct");
    expect(res.kinds).toContain("docker");
  });
});
