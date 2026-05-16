import { Worker, NativeConnection } from "@temporalio/worker";
import { loadAppConfig } from "../config.js";
import { AppContext } from "../app.js";
import { depsFromApp } from "../services/deps.js";
import * as actProvision from "./activities/provision-compute.js";
import * as actDestroy from "./activities/destroy-compute.js";
import * as actDispatch from "./activities/dispatch-stage.js";
import * as actAwait from "./activities/await-stage-completion.js";
import * as actAction from "./activities/execute-action.js";
import * as actVerify from "./activities/run-verification.js";
import * as actProjSession from "./activities/project-session.js";
import * as actProjStage from "./activities/project-stage.js";
import * as actLoadFlow from "./activities/load-flow.js";
import * as activities from "./activities/index.js";

async function main() {
  const config = await loadAppConfig();

  const app = new AppContext(config);
  await app.boot();

  // Durable process-trace: the dispatch lifecycle + arkd-events consumer
  // run in THIS process. Shipping its logfile to the blob store is what
  // makes Temporal-side failures diagnosable after the pod is gone (the
  // hook-pipeline regression lived here and was invisible). Path matches
  // the temporal-worker entrypoint's tee target.
  const { startProcessTraceShipping } = await import("../observability/process-trace.js");
  startProcessTraceShipping(app, "temporal-worker", "/tmp/ark-temporal-worker.log");

  const deps = depsFromApp(app);

  actProvision.injectDeps(deps);
  actDestroy.injectDeps(deps);
  actDispatch.injectDeps(deps);
  actAwait.injectDeps(deps);
  actAction.injectDeps(deps);
  actVerify.injectDeps(deps);
  actProjSession.injectDeps(deps);
  actProjStage.injectDeps(deps);
  actLoadFlow.injectDeps(deps);

  const connection = await NativeConnection.connect({ address: config.temporal.serverUrl });

  const queues =
    config.temporal.taskQueueAssignments.length > 0
      ? config.temporal.taskQueueAssignments
      : [`ark.${config.authSection.defaultTenant ?? "default"}.stages`];

  // `worker.run()` blocks until shutdown. Awaiting it inside the loop would
  // silently ignore every queue after the first. Create all workers up front,
  // then run them concurrently so a multi-tenant taskQueueAssignments config
  // actually pulls from every queue.
  const workers = await Promise.all(
    queues.map((taskQueue) =>
      Worker.create({
        connection,
        namespace: config.temporal.namespace,
        taskQueue,
        workflowsPath: new URL("./workflows/workflows-entrypoint.ts", import.meta.url).pathname,
        activities,
      }),
    ),
  );
  await Promise.all(workers.map((w) => w.run()));
}

main().catch((err) => {
  console.error("Temporal worker fatal:", err);
  process.exit(1);
});
