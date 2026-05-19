/**
 * `compute/template/list` RPC -- every template row carries the new
 * `compute` + `isolation` axes (and a synthesized legacy `provider` name
 * for back-compat readers). The web bundle used to maintain its own
 * provider-map copy to derive the axes; the server now does the derivation
 * once so the client can read `tmpl.compute` + `tmpl.isolation` directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { registerResourceHandlers } from "../resource.js";
import { Router } from "../../router.js";
import { createRequest, type JsonRpcResponse } from "../../../protocol/types.js";

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

function ok(res: unknown): Record<string, unknown> {
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

describe("compute/template/list", () => {
  it("returns the two-axis (compute, isolation) pair", async () => {
    type Row = { compute: string; isolation: string };
    const rows: Row[] = [
      { compute: "local", isolation: "direct" },
      { compute: "local", isolation: "docker" },
      { compute: "local", isolation: "devcontainer" },
      { compute: "ec2", isolation: "direct" },
      { compute: "ec2", isolation: "docker" },
      { compute: "ec2", isolation: "devcontainer" },
      { compute: "k8s", isolation: "direct" },
    ];
    const tname = (r: Row) => `tmpl-${r.compute}-${r.isolation}`;

    for (const r of rows) {
      await app.computeTemplates.create({
        name: tname(r),
        description: `Test template for ${r.compute}/${r.isolation}`,
        compute: r.compute as any,
        isolation: r.isolation as any,
        config: {},
      });
    }

    const res = await router.dispatch(createRequest(1, "compute/template/list", {}));
    const templates = ok(res).templates as Array<Record<string, unknown>>;

    for (const t of templates) {
      expect(typeof t.compute).toBe("string");
      expect(typeof t.isolation).toBe("string");
    }

    for (const r of rows) {
      const row = templates.find((t) => t.name === tname(r));
      expect(row).toBeDefined();
      expect(row!.compute).toBe(r.compute);
      expect(row!.isolation).toBe(r.isolation);
    }
  });
});
