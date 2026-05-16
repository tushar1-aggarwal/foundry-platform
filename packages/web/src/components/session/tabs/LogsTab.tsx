import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../../hooks/useApi.js";
import { cn } from "../../../lib/utils.js";

interface LogsTabProps {
  sessionId: string;
  /** Session status -- polling halts on terminal states. */
  status?: string | null;
}

const TERMINAL_STATES = new Set(["completed", "failed", "stopped", "archived"]);
const POLL_INTERVAL_MS = 2000;
const TAIL_DEFAULT = 500;

/**
 * Multi-source durable-trace viewer. Every observability artefact Ark
 * captures is reachable here, not just agent stdout:
 *   - Agent stdio       session/stdio        (the agent pod's stdout)
 *   - Transcript        session/transcript   (SDK messages + tool calls)
 *   - Pipeline          session/events       (the durable arkd_* hook-
 *                                             pipeline causal chain)
 *   - Conductor daemon  diagnostics/processLog component=conductor-daemon
 *   - Temporal worker   diagnostics/processLog component=temporal-worker
 *
 * The last three survive pod death (blob-backed); they're the traces that
 * root-caused the hook-pipeline regression and were previously RPC-only.
 */
type LogSource = "stdio" | "transcript" | "pipeline" | "conductor-daemon" | "temporal-worker";

const SOURCES: { id: LogSource; label: string }[] = [
  { id: "stdio", label: "Agent stdio" },
  { id: "transcript", label: "Transcript" },
  { id: "pipeline", label: "Pipeline" },
  { id: "conductor-daemon", label: "Conductor" },
  { id: "temporal-worker", label: "Worker" },
];

/** Line-based sources honour the tail toggle; structured ones don't. */
const LINE_SOURCES = new Set<LogSource>(["stdio", "conductor-daemon", "temporal-worker"]);

function compactJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s && s !== "{}" ? s : "";
  } catch {
    return "";
  }
}

function formatTranscriptLine(m: any): string | null {
  if (!m || typeof m !== "object") return null;
  const t = m.type;
  if (t === "system") return `system${m.subtype ? `/${m.subtype}` : ""}${m.model ? ` model=${m.model}` : ""}`;
  if (t === "result") {
    const cost = typeof m.total_cost_usd === "number" ? ` $${m.total_cost_usd.toFixed(4)}` : "";
    return `result ${m.is_error ? "ERROR" : "ok"}${cost}${m.num_turns ? ` ${m.num_turns} turns` : ""}: ${(
      m.result ??
      m.error ??
      ""
    )
      .toString()
      .slice(0, 160)}`;
  }
  const content = m.message?.content ?? m.content;
  if (typeof content === "string") return `${t}: ${content.slice(0, 200)}`;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (b?.type === "text") return `${t}: ${String(b.text).slice(0, 200)}`;
        if (b?.type === "thinking") return `${t} (thinking): ${String(b.thinking).slice(0, 160)}`;
        if (b?.type === "tool_use") return `-> tool ${b.name} ${compactJson(b.input).slice(0, 160)}`;
        if (b?.type === "tool_result") return `<- tool_result ${b.is_error ? "ERROR" : "ok"}`;
        return `${t}: ${b?.type ?? "?"}`;
      })
      .join("\n");
  }
  return `${t}`;
}

export function LogsTab({ sessionId, status }: LogsTabProps) {
  const [source, setSource] = useState<LogSource>("stdio");
  const [tailMode, setTailMode] = useState<boolean>(true);
  const [autoscroll, setAutoscroll] = useState<boolean>(true);

  const preRef = useRef<HTMLPreElement | null>(null);
  const api = useApi();

  const isRunning = !!status && !TERMINAL_STATES.has(status);
  const tail = tailMode ? TAIL_DEFAULT : undefined;
  const honoursTail = LINE_SOURCES.has(source);

  const query = useQuery({
    queryKey: ["session-logs", sessionId, source, honoursTail ? (tail ?? "all") : "n/a"],
    queryFn: async (): Promise<string[]> => {
      if (source === "stdio") {
        const r = await api.getStdio(sessionId, tail ? { tail } : undefined);
        return (r.content ?? "").split("\n");
      }
      if (source === "transcript") {
        const r = await api.getTranscript(sessionId);
        return (r.messages ?? [])
          .map(formatTranscriptLine)
          .filter((x): x is string => !!x)
          .join("\n")
          .split("\n");
      }
      if (source === "pipeline") {
        const r = await api.getSessionEvents(sessionId);
        return (r.events ?? [])
          .filter((e: any) => typeof e?.type === "string" && e.type.startsWith("arkd_"))
          .map((e: any) => {
            const ts = (e.created_at ?? e.ts ?? "").toString().slice(11, 19);
            const d = compactJson(e.data);
            return `${ts ? ts + " " : ""}${e.type}${d ? " " + d : ""}`;
          });
      }
      const r = await api.getProcessLog(source, tail ? { tail } : undefined);
      return (r.content ?? "").split("\n");
    },
    refetchInterval: isRunning ? POLL_INTERVAL_MS : false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const lines = useMemo<string[]>(() => {
    const parts = (query.data ?? []).slice();
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts;
  }, [query.data]);

  useEffect(() => {
    if (!autoscroll) return;
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, autoscroll]);

  const sourceLabel = SOURCES.find((s) => s.id === source)?.label ?? source;

  return (
    <div data-testid="logs-tab" className="panel-card">
      <div className="panel-card-header">
        <div className="flex items-center gap-[4px]" data-testid="logs-source-switcher">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSource(s.id)}
              className={cn(
                "px-[8px] py-[3px] rounded-[4px] text-[10px] font-[family-name:var(--font-mono-ui)] border",
                s.id === source
                  ? "border-[var(--accent)] text-[var(--fg)] bg-[rgba(107,89,222,0.12)]"
                  : "border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)] bg-[rgba(0,0,0,0.2)]",
              )}
              data-testid={`logs-source-${s.id}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {isRunning && (
          <span className="text-[9.5px] uppercase tracking-[0.05em] text-[#86efac]" data-testid="logs-live-indicator">
            live
          </span>
        )}
        <div className="ml-auto flex items-center gap-[6px]">
          {honoursTail && (
            <button
              type="button"
              onClick={() => setTailMode((t) => !t)}
              className={cn(
                "px-[8px] py-[3px] rounded-[4px] text-[10px] font-[family-name:var(--font-mono-ui)]",
                "border border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]",
                "bg-[rgba(0,0,0,0.2)]",
              )}
              data-testid="logs-tail-toggle"
            >
              {tailMode ? `Last ${TAIL_DEFAULT}` : "All"}
            </button>
          )}
          <label className="flex items-center gap-[4px] text-[10px] text-[var(--fg-muted)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
              className="w-[11px] h-[11px]"
              data-testid="logs-autoscroll-toggle"
            />
            autoscroll
          </label>
        </div>
      </div>

      {query.isError && (
        <div className="px-[12px] py-[10px] text-[11px] text-[#f87171]" data-testid="logs-error">
          Failed to load {sourceLabel}: {(query.error as Error)?.message ?? "unknown error"}
        </div>
      )}

      {!query.isError && lines.length === 0 && (
        <div className="panel-card-empty" data-testid="logs-empty">
          <div>No {sourceLabel.toLowerCase()} output</div>
          {status && <div className="panel-card-empty-meta">status · {status}</div>}
        </div>
      )}

      {lines.length > 0 && (
        <pre ref={preRef} data-testid="logs-body" className="panel-log-body">
          {lines.map((ln, i) => {
            const muted = ln.trimStart().startsWith("[exec ") || source === "pipeline";
            return (
              <div key={i} className="panel-log-line">
                <span className="panel-log-gutter">{i + 1}</span>
                <span className={cn("panel-log-content", muted && "muted")}>{ln || " "}</span>
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}
