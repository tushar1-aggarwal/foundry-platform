/**
 * Non-Claude transcript billing.
 *
 * Claude usage is captured live via hooks (applyHookStatus). Codex / Gemini
 * runtimes don't emit hooks, so their token usage is recovered by parsing
 * the agent transcript when a stage finishes. Extracted from the bespoke
 * StageAdvanceService so the Temporal lifecycle seam can own it.
 *
 * Best-effort: a missing parser / transcript / workdir is normal (Claude
 * stages, no work done) and must never fail the lifecycle transition.
 */

import type { Session } from "../../types/index.js";
import type { OrchestrationDeps } from "./deps.js";
import { logError } from "../observability/structured-log.js";

export async function captureNonClaudeUsage(d: OrchestrationDeps, session: Session): Promise<void> {
  try {
    const app = d.app;
    if (!app) return;
    const runtimeName = (session.config?.runtime as string | undefined) ?? session.agent;
    if (!runtimeName) return;
    const runtime = await d.runtimes.get(runtimeName);
    const parserKind = runtime?.billing?.transcript_parser;
    if (!parserKind || parserKind === "claude") return;

    const parser = app.transcriptParsers.get(parserKind);
    if (!parser) {
      logError("session", "no transcript parser registered", { sessionId: session.id, kind: parserKind });
      return;
    }
    if (!session.workdir) return;

    const transcriptPath = parser.findForSession({
      workdir: session.workdir,
      startTime: session.created_at ? new Date(session.created_at) : undefined,
    });
    if (!transcriptPath) return;

    const result = parser.parse(transcriptPath);
    if (result.usage.input_tokens > 0 || result.usage.output_tokens > 0) {
      const provider = parserKind === "codex" ? "openai" : parserKind === "gemini" ? "google" : parserKind;
      await app.sessionCreator.recordUsage(session, result.usage, provider, "transcript");
    }
  } catch (e: any) {
    logError("session", "non-Claude transcript parsing failed", {
      sessionId: session.id,
      error: String(e?.message ?? e),
    });
  }
}
