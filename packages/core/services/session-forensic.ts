/**
 * Session forensic-file helpers.
 *
 * Every session writes two observability artefacts under `<tracksDir>/<id>/`:
 *   - `stdio.log`        -- raw dispatcher stdout + `[exec ...]` lines
 *   - `transcript.jsonl` -- agent-sdk message stream (one JSON per line)
 *
 * These helpers read those files with a hard size cap so a runaway log can't
 * OOM the conductor, and implement the `?tail=<N>` semantics used by the
 * `GET /api/sessions/:id/stdio` HTTP route + `session/stdio` RPC method.
 *
 * Callers are responsible for 404-ing when the session itself is missing --
 * this module only deals with files and file shapes.
 */

import { promises as fsPromises } from "node:fs";
import { join } from "node:path";

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import { encodeLocator, LOCAL_TENANT_ID } from "../storage/blob-store.js";

/** Worker-side dir the agent writes stdio.log + transcript.jsonl into. */
export function workerSessionDir(sessionId: string): string {
  return `/tmp/ark-${sessionId}`;
}

const FORENSIC_FILES = ["stdio.log", "transcript.jsonl"] as const;
const FORENSIC_NS = "forensics";
/** Cap bytes pulled off the worker + pushed to the blob store. */
const FORENSIC_MAX_BYTES = 8 * 1024 * 1024;

/** Absolute upper bound on bytes returned per request. ~2MB per the UI spec. */
export const MAX_FORENSIC_BYTES = 2 * 1024 * 1024;

export interface ForensicReadResult {
  /** File contents (possibly tail-sliced). Empty string when file is missing. */
  content: string;
  /** File existed on disk. */
  exists: boolean;
  /** Full file size in bytes (0 when missing). */
  size: number;
  /** True when the file is larger than `MAX_FORENSIC_BYTES` and `tail` was not supplied. */
  tooLarge: boolean;
}

/** A tail value is "usable" only when it's a finite positive number. */
function hasTail(tail?: number): tail is number {
  return tail != null && Number.isFinite(tail) && tail > 0;
}

/** Over the cap with no tail hint -> refuse (caller returns tooLarge). */
function isForensicTooLarge(size: number, tail?: number): boolean {
  return size > MAX_FORENSIC_BYTES && !hasTail(tail);
}

/**
 * Keep the last `tail` visible lines of an in-memory forensic buffer.
 * No-op when `tail` is unusable. The final element is the empty
 * trailing-newline remnant when the buffer ended in `\n`; drop it before
 * counting so `tail=10` means the last 10 visible lines, then restore the
 * trailing newline so the client never renders a half-record.
 */
function applyForensicTail(raw: string, tail?: number): string {
  if (!hasTail(tail)) return raw;
  const lines = raw.split("\n");
  const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === "";
  const body = trailingEmpty ? lines.slice(0, -1) : lines;
  return body.slice(Math.max(0, body.length - Math.floor(tail))).join("\n") + (trailingEmpty ? "\n" : "");
}

/**
 * Read a forensic file from `<tracksDir>/<sessionId>/<file>` with tail support.
 *
 * Semantics:
 *   - Missing file          -> `{ content: "", exists: false, size: 0, tooLarge: false }`
 *   - File size <= cap      -> full content (or last `tail` lines if supplied)
 *   - File size > cap + no tail -> `{ content: "", exists: true, tooLarge: true, size }`
 *   - File size > cap + tail    -> read the last `<max>` bytes then keep the last `tail` lines
 */
export async function readForensicFile(
  tracksDir: string,
  sessionId: string,
  fileName: string,
  opts: { tail?: number } = {},
): Promise<ForensicReadResult> {
  const path = join(tracksDir, sessionId, fileName);
  let stat: { size: number } | null = null;
  try {
    const s = await fsPromises.stat(path);
    stat = { size: s.size };
  } catch {
    return { content: "", exists: false, size: 0, tooLarge: false };
  }

  const size = stat.size;
  const { tail } = opts;

  if (isForensicTooLarge(size, tail)) {
    return { content: "", exists: true, size, tooLarge: true };
  }

  // When we have to honour tail on a huge file we read the last MAX bytes so
  // the slice we hand back always fits under the cap.
  let raw: string;
  if (size > MAX_FORENSIC_BYTES) {
    const fh = await fsPromises.open(path, "r");
    try {
      const offset = size - MAX_FORENSIC_BYTES;
      const buf = Buffer.alloc(MAX_FORENSIC_BYTES);
      await fh.read(buf, 0, MAX_FORENSIC_BYTES, offset);
      raw = buf.toString("utf8");
      // Strip any partial first line -- tail semantics must always start at a
      // line boundary so the client never renders half a record.
      const firstNl = raw.indexOf("\n");
      if (firstNl >= 0) raw = raw.slice(firstNl + 1);
    } finally {
      await fh.close();
    }
  } else {
    raw = await fsPromises.readFile(path, "utf8");
  }

  return { content: applyForensicTail(raw, tail), exists: true, size, tooLarge: false };
}

/** Parse an NDJSON forensic string into an array; skips blank + unparseable lines. */
export function parseJsonl(content: string): unknown[] {
  if (!content) return [];
  const out: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Corrupt line (partial write, non-JSON noise) -- drop it rather than
      // failing the whole request. The client only needs well-formed records.
    }
  }
  return out;
}

/**
 * Pull the worker's stdio.log + transcript.jsonl off the (about-to-be-reaped)
 * compute pod via arkd /file/read and persist them to the durable blob store.
 *
 * Hosted dispatch skips the conductor-side tee (the dispatcher disk is shared
 * + ephemeral), so without this the only copy of what the agent did dies with
 * the pod. Called at terminal and on a heartbeat so a killed/hung pod still
 * leaves an audit trail; the blob key is deterministic so the read path can
 * reconstruct the locator without persisting it on the session row.
 *
 * Strictly best-effort: any failure (arkd already gone, file absent, blob
 * backend hiccup) is swallowed -- forensic capture must never fail a session.
 * Returns the tail of stdio.log so the caller can fold the real reason into
 * the failure record.
 */
export async function captureWorkerForensics(
  app: AppContext,
  session: Session,
  arkdUrl: string,
): Promise<{ stdioTail: string }> {
  let stdioTail = "";
  try {
    const { ArkdClient } = await import("../../arkd/client/index.js");
    const client = new ArkdClient(arkdUrl, { requestTimeoutMs: 8_000 });
    const dir = workerSessionDir(session.id);
    const tenantId = session.tenant_id ?? LOCAL_TENANT_ID;
    for (const fileName of FORENSIC_FILES) {
      try {
        const res = await client.readFile(`${dir}/${fileName}`);
        const content = res?.content ?? "";
        if (!content) continue;
        const bytes = Buffer.from(content, "utf-8").subarray(0, FORENSIC_MAX_BYTES);
        await app.blobStore.put({ tenantId, namespace: FORENSIC_NS, id: session.id, filename: fileName }, bytes, {
          contentType: fileName.endsWith(".jsonl") ? "application/x-ndjson" : "text/plain",
          maxBytes: FORENSIC_MAX_BYTES,
        });
        if (fileName === "stdio.log") {
          stdioTail = content.split("\n").filter(Boolean).slice(-40).join("\n");
        }
      } catch {
        // per-file best-effort: file may not exist yet, or the pod is gone
      }
    }
  } catch {
    // arkd unreachable / pod already torn down -- nothing to capture
  }
  return { stdioTail };
}

/**
 * Read a forensic file, preferring the local conductor-side tee but falling
 * back to the durable blob snapshot when the tee is absent (the hosted-mode
 * case, where the worker pod -- and its /tmp -- is long gone by the time
 * someone opens the Logs tab).
 */
export async function readSessionForensic(
  app: AppContext,
  session: Session,
  fileName: string,
  opts: { tail?: number } = {},
): Promise<ForensicReadResult> {
  const local = await readForensicFile(app.config.dirs.tracks, session.id, fileName, opts);
  if (local.exists || local.tooLarge) return local;
  try {
    const tenantId = session.tenant_id ?? LOCAL_TENANT_ID;
    const locator = encodeLocator({ tenantId, namespace: FORENSIC_NS, id: session.id, filename: fileName });
    const { bytes } = await app.blobStore.get(locator, tenantId);
    const size = bytes.byteLength;
    if (isForensicTooLarge(size, opts.tail)) {
      return { content: "", exists: true, size, tooLarge: true };
    }
    return { content: applyForensicTail(bytes.toString("utf-8"), opts.tail), exists: true, size, tooLarge: false };
  } catch {
    return { content: "", exists: false, size: 0, tooLarge: false };
  }
}
