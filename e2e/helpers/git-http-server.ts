import { spawn } from "child_process";
import { appendFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";

export interface GitHttpServerOpts {
  /** Path to a bare git repo on disk (created by the caller). */
  repoPath: string;
  /** Token that the Authorization: Basic header's password part must equal. */
  expectedToken: string;
  /** Optional: append every Authorization header to this file (debug aid). */
  logFile?: string;
  /** Bind address. Use 127.0.0.1 for local mode; 0.0.0.0 to be reachable from
   *  a docker sidecar via host.docker.internal in hosted mode. */
  bindAddr?: string;
}

export interface GitHttpServerHandle {
  /** Full URL including /repo.git path component. Pass this to session/start. */
  url: string;
  port: number;
  kill: () => Promise<void>;
}

function resolveGitHttpBackend(): string {
  const execPath = execFileSync("git", ["--exec-path"]).toString().trim();
  const candidate = `${execPath}/git-http-backend`;
  if (!existsSync(candidate)) {
    throw new Error(`git-http-backend not found at ${candidate}. Ensure git is installed with HTTP support.`);
  }
  return candidate;
}

export async function startGitHttpServer(opts: GitHttpServerOpts): Promise<GitHttpServerHandle> {
  const backend = resolveGitHttpBackend();
  const expected = `Basic ${Buffer.from(`user:${opts.expectedToken}`).toString("base64")}`;
  const bind = opts.bindAddr ?? "127.0.0.1";

  const parentDir = opts.repoPath.replace(/\/[^/]+$/, "");
  const repoBasename = opts.repoPath.split("/").pop()!;

  const server = Bun.serve({
    hostname: bind,
    port: 0,
    async fetch(req: Request) {
      const auth = req.headers.get("authorization") ?? "";

      if (opts.logFile) {
        try {
          appendFileSync(opts.logFile, `${new Date().toISOString()} ${req.method} ${new URL(req.url).pathname} auth=${auth}\n`);
        } catch { /* best-effort */ }
      }

      if (auth !== expected) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="git"' },
        });
      }

      const url = new URL(req.url);
      const incomingPath = url.pathname;
      const rest = incomingPath.startsWith("/repo.git") ? incomingPath.slice("/repo.git".length) : incomingPath;
      const pathInfo = `/${repoBasename}${rest}`;

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        GIT_PROJECT_ROOT: parentDir,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: pathInfo,
        REQUEST_METHOD: req.method,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers.get("content-type") ?? "",
        CONTENT_LENGTH: req.headers.get("content-length") ?? "",
        REMOTE_USER: "user",
      };

      // Buffer the full body before spawning CGI — git-http-backend needs
      // complete stdin before producing stdout, so streaming isn't safe here.
      const bodyBuf = req.body ? Buffer.from(await req.arrayBuffer()) : null;

      const cgi = spawn(backend, [], { env });

      if (bodyBuf && bodyBuf.length > 0) {
        cgi.stdin!.write(bodyBuf);
      }
      cgi.stdin!.end();

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      cgi.stdout!.on("data", (c) => chunks.push(c));
      cgi.stderr!.on("data", (c) => errChunks.push(c));
      const exitCode: number = await new Promise((resolve) => cgi.on("exit", (code) => resolve(code ?? 0)));

      if (exitCode !== 0) {
        return new Response(`git-http-backend failed: ${Buffer.concat(errChunks).toString()}`, { status: 500 });
      }

      const buf = Buffer.concat(chunks);
      let sepIdx = buf.indexOf("\r\n\r\n");
      let sepLen = 4;
      if (sepIdx === -1) {
        sepIdx = buf.indexOf("\n\n");
        sepLen = 2;
      }
      if (sepIdx === -1) {
        return new Response(buf, { status: 200 });
      }
      const headerBlob = buf.subarray(0, sepIdx).toString("utf-8");
      const body = buf.subarray(sepIdx + sepLen);

      const headers = new Headers();
      let status = 200;
      for (const line of headerBlob.split(/\r?\n/)) {
        if (!line) continue;
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (!m) continue;
        const [, name, value] = m;
        if (name.toLowerCase() === "status") {
          const code = parseInt(value.split(" ")[0], 10);
          if (!isNaN(code)) status = code;
        } else {
          headers.set(name, value);
        }
      }

      return new Response(body, { status, headers });
    },
  });

  const port = server.port;
  const url = `http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${port}/repo.git`;

  return {
    url,
    port,
    kill: async () => {
      server.stop(true);
    },
  };
}
