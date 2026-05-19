/**
 * Compute.resolveWorkdir tests.
 *
 * Pure transformation -- no AppContext / network / SSH stubs needed.
 * The interface method is optional; LocalCompute omits it (callers fall
 * back to session.workdir), K8sCompute returns null pending the pod-side
 * mount layout, and EC2Compute mirrors the legacy
 * `${remoteHome}/Projects/<sid>/<repo>` shape.
 */

import { describe, expect, test } from "bun:test";
import { LocalCompute } from "../local.js";
import { EC2Compute } from "../ec2/compute.js";

const STUB_APP = {} as never;

describe("Compute.resolveWorkdir", () => {
  test("LocalCompute does not implement resolveWorkdir (caller falls back)", () => {
    const c = new LocalCompute(STUB_APP);
    // Either undefined (omitted) or returning null is acceptable. The
    // current LocalCompute omits the method entirely; the dispatcher's
    // null/undefined fallback path covers either shape.
    if (c.resolveWorkdir) {
      const r = c.resolveWorkdir({ kind: "local", name: "x", meta: {} }, {
        id: "s-test",
        workdir: "/Users/me/repo",
      } as never);
      expect(r).toBeNull();
    } else {
      expect(c.resolveWorkdir).toBeUndefined();
    }
  });

  test("EC2Compute returns the remote-host path", () => {
    const c = new EC2Compute(STUB_APP);
    const r = c.resolveWorkdir!({ kind: "ec2", name: "ec2-test", meta: { ec2: { remoteHome: "/home/ubuntu" } } }, {
      id: "s-abc",
      config: { remoteRepo: "git@example.com:org/repo.git" },
      repo: null,
    } as never);
    expect(r).toBe("/home/ubuntu/Projects/s-abc/repo");
  });

  test("EC2Compute strips .git suffix from the repo basename", () => {
    const c = new EC2Compute(STUB_APP);
    const r = c.resolveWorkdir!({ kind: "ec2", name: "ec2-test", meta: { ec2: {} } }, {
      id: "s-abc",
      config: { remoteRepo: "git@bitbucket.org:team/payments-service.git" },
      repo: null,
    } as never);
    // Default remoteHome falls back to /home/ubuntu when meta.ec2.remoteHome is missing.
    expect(r).toBe("/home/ubuntu/Projects/s-abc/payments-service");
  });

  test("EC2Compute prefers session.config.remoteRepo over session.repo", () => {
    const c = new EC2Compute(STUB_APP);
    const r = c.resolveWorkdir!({ kind: "ec2", name: "ec2-test", meta: { ec2: { remoteHome: "/home/ubuntu" } } }, {
      id: "s-abc",
      config: { remoteRepo: "git@example.com:org/winner.git" },
      repo: "loser",
    } as never);
    expect(r).toBe("/home/ubuntu/Projects/s-abc/winner");
  });

  test("EC2Compute falls back to session.repo when remoteRepo is unset", () => {
    const c = new EC2Compute(STUB_APP);
    const r = c.resolveWorkdir!({ kind: "ec2", name: "ec2-test", meta: { ec2: { remoteHome: "/home/ubuntu" } } }, {
      id: "s-abc",
      config: {},
      repo: "/Users/me/Projects/fallback",
    } as never);
    expect(r).toBe("/home/ubuntu/Projects/s-abc/fallback");
  });

  test("EC2Compute returns null when neither remoteRepo nor session.repo is set", () => {
    const c = new EC2Compute(STUB_APP);
    const r = c.resolveWorkdir!({ kind: "ec2", name: "ec2-test", meta: { ec2: {} } }, {
      id: "s-abc",
      config: {},
      repo: null,
    } as never);
    expect(r).toBeNull();
  });
});
