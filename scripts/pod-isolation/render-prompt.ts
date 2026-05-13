#!/usr/bin/env bun
/**
 * Render the agent's system_prompt + the stage's task prompt using the same
 * Nunjucks code path CP uses in production. Output is a single JSON envelope on
 * stdout the driver script can ingest with jq.
 *
 * Usage:
 *   bun render-prompt.ts <agent_yaml_path> <stage_name> [--session-id ID]
 *                        [--workdir PATH] [--repo URL] [--branch NAME]
 *                        [--summary TEXT] [--ticket TEXT]
 *
 * Reads from process.env when flags are omitted:
 *   ARK_SESSION_ID, ARK_WORKTREE, ARK_REPO, ARK_BRANCH, ARK_SUMMARY, ARK_TICKET
 *
 * Why this script exists: we want the bytes of `system_prompt_append` and the
 * `task_prompt` (the content of $ARK_PROMPT_FILE) to byte-match what production
 * CP would produce, so the captured contract is reusable when fixing the
 * Temporal/CP path.
 */
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { substituteVars, buildSessionVars } from "../../packages/core/template.js";

interface Args {
  agentYaml: string;
  stage: string;
  sessionId: string;
  workdir: string;
  repo: string;
  branch: string;
  summary: string;
  ticket: string | null;
  runtimeYaml: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error(
      "usage: render-prompt.ts <agent_yaml_path> <stage_name> [--session-id ID] " +
        "[--workdir PATH] [--repo URL] [--branch NAME] [--summary TEXT] [--ticket TEXT] " +
        "[--runtime-yaml PATH]",
    );
    process.exit(2);
  }
  const out: Args = {
    agentYaml: argv[0],
    stage: argv[1],
    sessionId: process.env.ARK_SESSION_ID ?? `iso-${Date.now()}`,
    workdir: process.env.ARK_WORKTREE ?? "/tmp/ark-workdir",
    repo: process.env.ARK_REPO ?? "",
    branch: process.env.ARK_BRANCH ?? "main",
    summary: process.env.ARK_SUMMARY ?? "(no summary)",
    ticket: process.env.ARK_TICKET || null,
    runtimeYaml: "/app/runtimes/claude-agent.yaml",
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k.startsWith("--") || v === undefined) continue;
    switch (k) {
      case "--session-id":
        out.sessionId = v;
        break;
      case "--workdir":
        out.workdir = v;
        break;
      case "--repo":
        out.repo = v;
        break;
      case "--branch":
        out.branch = v;
        break;
      case "--summary":
        out.summary = v;
        break;
      case "--ticket":
        out.ticket = v || null;
        break;
      case "--runtime-yaml":
        out.runtimeYaml = v;
        break;
    }
    i++;
  }
  return out;
}

function main(): void {
  const args = parseArgs();
  const agentDoc = parseYaml(readFileSync(args.agentYaml, "utf8")) as Record<string, unknown>;
  const runtimeDoc = parseYaml(readFileSync(args.runtimeYaml, "utf8")) as Record<string, unknown>;

  // Production CP builds vars via buildSessionVars(session-row).
  // We construct a minimal Session-shaped record with the same fields the
  // agent YAMLs reference: id, workdir, repo, branch, summary, ticket, stage.
  // buildSessionVars adds session_id and flattens config.inputs.* (absent here).
  const session: Record<string, unknown> = {
    id: args.sessionId,
    workdir: args.workdir,
    repo: args.repo,
    branch: args.branch,
    summary: args.summary,
    ticket: args.ticket,
    stage: args.stage,
    flow: "docs",
    runtime: "claude-agent",
    tenant_id: "default",
  };
  const vars = buildSessionVars(session);

  // Render system_prompt + per-runtime overrides
  const rawSystemPrompt = (agentDoc.system_prompt as string | undefined) ?? "";
  const systemPromptAppend = rawSystemPrompt ? substituteVars(rawSystemPrompt, vars) : "";

  // Task prompt mirrors task-builder.ts:formatTaskHeader for the no-stage-task
  // path that docs.yaml takes (its plan + implement stages have no explicit
  // `task:` field). Order matches production:
  //   1) "Work on <ticket||id>: <summary>"
  //   2) "You are the <agent> agent, running the '<stage>' stage."
  //   3) runtime.task_prompt verbatim (claude-agent's "stop with final message")
  const agentName = (agentDoc.name as string | undefined) ?? "agent";
  const ticketOrId = args.ticket ?? args.sessionId;
  const taskParts: string[] = [];
  taskParts.push(`Work on ${ticketOrId}: ${args.summary}`);
  taskParts.push(`\nYou are the ${agentName} agent, running the '${args.stage}' stage.`);
  const runtimeTaskPrompt = runtimeDoc.task_prompt as string | undefined;
  if (runtimeTaskPrompt) {
    taskParts.push(runtimeTaskPrompt);
  }
  const taskPrompt = taskParts.join("\n");

  const envelope = {
    stage: args.stage,
    agent: agentName,
    session_id: args.sessionId,
    vars: {
      session_id: args.sessionId,
      workdir: args.workdir,
      repo: args.repo,
      branch: args.branch,
      summary: args.summary,
      ticket: args.ticket,
      stage: args.stage,
    },
    system_prompt_append: systemPromptAppend,
    task_prompt: taskPrompt,
  };
  process.stdout.write(JSON.stringify(envelope, null, 2));
  process.stdout.write("\n");
}

main();
