import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync, execFile } from "child_process";
import { promisify } from "util";

import { startGitHttpServer } from "../git-http-server.js";

const execFileAsync = promisify(execFile);

const TOKEN = "test-fake-token-XYZ";

function initBareRepoWithSeed(): string {
  const tmp = mkdtempSync(join(tmpdir(), "ark-git-server-test-"));
  const bare = join(tmp, "fake-bitbucket.git");
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  const working = join(tmp, "working");
  execFileSync("git", ["clone", bare, working]);
  execFileSync("bash", ["-c", "echo initial > README.md"], { cwd: working });
  execFileSync("git", ["-C", working, "-c", "user.email=test@x", "-c", "user.name=test", "add", "README.md"]);
  execFileSync("git", ["-C", working, "-c", "user.email=test@x", "-c", "user.name=test", "commit", "-m", "initial"]);
  execFileSync("git", ["-C", working, "push", "origin", "main"]);
  return bare;
}

describe("git-http-server", () => {
  let cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const c = cleanups.pop()!;
      try { await c(); } catch {}
    }
  });

  test("rejects requests without Authorization header", async () => {
    const repoPath = initBareRepoWithSeed();
    cleanups.push(() => rmSync(join(repoPath, ".."), { recursive: true, force: true }));

    const server = await startGitHttpServer({ repoPath, expectedToken: TOKEN });
    cleanups.push(() => server.kill());

    const r = await fetch(`${server.url}/info/refs?service=git-upload-pack`);
    expect(r.status).toBe(401);
  });

  test("accepts requests with the correct basic-auth token and serves git protocol", async () => {
    const repoPath = initBareRepoWithSeed();
    const cloneTmp = mkdtempSync(join(tmpdir(), "ark-git-clone-"));
    cleanups.push(() => rmSync(join(repoPath, ".."), { recursive: true, force: true }));
    cleanups.push(() => rmSync(cloneTmp, { recursive: true, force: true }));

    const server = await startGitHttpServer({ repoPath, expectedToken: TOKEN });
    cleanups.push(() => server.kill());

    const url = new URL(server.url);
    const authedUrl = `${url.protocol}//user:${TOKEN}@${url.host}${url.pathname}`;

    const target = join(cloneTmp, "clone");
    // Must use async execFile — execFileSync blocks the event loop and prevents
    // Bun.serve from responding to git's HTTP requests.
    await execFileAsync("git", ["-c", "credential.helper=", "clone", authedUrl, target]);

    const { stdout } = await execFileAsync("git", ["-C", target, "log", "--oneline"]);
    expect(stdout).toContain("initial");
  });

  test("rejects requests with the wrong token", async () => {
    const repoPath = initBareRepoWithSeed();
    cleanups.push(() => rmSync(join(repoPath, ".."), { recursive: true, force: true }));

    const server = await startGitHttpServer({ repoPath, expectedToken: TOKEN });
    cleanups.push(() => server.kill());

    const wrong = Buffer.from(`user:wrong-token`).toString("base64");
    const r = await fetch(`${server.url}/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Basic ${wrong}` },
    });
    expect(r.status).toBe(401);
  });
});
