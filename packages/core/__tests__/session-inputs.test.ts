/**
 * Session inputs plumbing: `session/start` carries generic files + params
 * through to `session.config.inputs`, which `buildSessionVars` flattens as
 * `inputs.files.*` / `inputs.params.*` for templating consumers.
 */

import { attachTemporalTestHarness, drainTemporalTestHarness, waitForSessionStatus } from "../temporal/test-harness.js";
import { describe, it, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../app.js";
import { buildSessionVars, substituteVars } from "../template.js";

let app: AppContext;
let detach: (() => void) | undefined;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  const flowDir = join(app.config.dirs.ark, "flows");
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(join(flowDir, "x-auto.yaml"), `name: x-auto\nstages:\n  - name: work\n    agent: implementer\n    gate: auto\n`);
  await app.boot();
  detach = await attachTemporalTestHarness(app);
});

afterEach(async () => {
  await drainTemporalTestHarness();
});

afterAll(async () => {
  detach?.();
  await app?.shutdown();
});

describe("session inputs plumbing", async () => {
  it(
    "persists inputs.files + inputs.params into session.config.inputs",
    async () => {
      const session = await app.sessionCreator.start({
        summary: "inputs-test",
        flow: "x-auto",
        inputs: {
          files: { recipe: "/tmp/r.yaml", prd: "/tmp/prd.md" },
          params: { jira_key: "IN-1234", auto: "false" },
        },
      });
      await waitForSessionStatus(app, session.id, ["completed", "failed"]);
      const config = session.config as Record<string, unknown>;
      const inputs = config.inputs as { files: Record<string, string>; params: Record<string, string> };

      expect(inputs.files.recipe).toBe("/tmp/r.yaml");
      expect(inputs.files.prd).toBe("/tmp/prd.md");
      expect(inputs.params.jira_key).toBe("IN-1234");
      expect(inputs.params.auto).toBe("false");
    },
    45_000,
  );

  it(
    "omits inputs when none supplied (no empty bag in config)",
    async () => {
      const session = await app.sessionCreator.start({ summary: "no-inputs", flow: "x-auto" });
      await waitForSessionStatus(app, session.id, ["completed", "failed"]);
      const config = session.config as Record<string, unknown>;
      expect(config.inputs).toBeUndefined();
    },
    45_000,
  );

  it(
    "buildSessionVars + substituteVars resolve {{inputs.files.X}} / {{inputs.params.X}}",
    async () => {
      const session = await app.sessionCreator.start({
        summary: "template-test",
        flow: "x-auto",
        inputs: {
          files: { recipe: "/tmp/goose.yaml" },
          params: { jira_key: "IN-99" },
        },
      });
      await waitForSessionStatus(app, session.id, ["completed", "failed"]);
      const vars = buildSessionVars(session as unknown as Record<string, unknown>);
      const rendered = substituteVars("recipe={{inputs.files.recipe}} key={{inputs.params.jira_key}}", vars);
      expect(rendered).toBe("recipe=/tmp/goose.yaml key=IN-99");
    },
    45_000,
  );
});
