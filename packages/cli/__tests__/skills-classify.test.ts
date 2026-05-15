/**
 * Tests for the sync-status classification function.
 *
 * The classifier is the pure decision boundary between the server's
 * minimal status enum and the CLI's user-facing verdict. Every cell
 * of the RFC §7 table is asserted explicitly so a future change to
 * one row can't silently flip the others.
 */

import { describe, expect, it } from "bun:test";
import { classifySyncStatus } from "../skills/classify.js";

describe("classifySyncStatus — RFC §7 verdict table", () => {
  it("up-to-date + matching local hash -> up-to-date (server == local == sidecar)", () => {
    expect(
      classifySyncStatus({
        serverStatus: "up-to-date",
        hasSidecar: true,
        localHashMatchesSidecar: true,
        serverHashMatchesSidecar: true,
      }),
    ).toBe("up-to-date");
  });

  it("up-to-date + diverging local hash -> local-ahead (server == sidecar, local moved)", () => {
    expect(
      classifySyncStatus({
        serverStatus: "up-to-date",
        hasSidecar: true,
        localHashMatchesSidecar: false,
        serverHashMatchesSidecar: true,
      }),
    ).toBe("local-ahead");
  });

  it("server-changed + matching local hash -> fast-forward-pull (server moved, local at sidecar)", () => {
    expect(
      classifySyncStatus({
        serverStatus: "server-changed",
        hasSidecar: true,
        localHashMatchesSidecar: true,
        serverHashMatchesSidecar: false,
      }),
    ).toBe("fast-forward-pull");
  });

  // Regression: pre-fix, the (server-changed, local!=sidecar) case
  // classified to "conflict" without checking whether the server
  // actually moved. A user who edited their local SKILL.md but hadn't
  // yet pushed (server unchanged from their last sync) saw a
  // misleading "conflict" verdict that triggered the LLM merge
  // credential discovery flow. With the new
  // `serverHashMatchesSidecar` bit, we correctly distinguish
  // "only local moved" (local-ahead) from "both moved" (conflict).
  it("server-changed + local moved + server still at sidecar -> local-ahead", () => {
    expect(
      classifySyncStatus({
        serverStatus: "server-changed",
        hasSidecar: true,
        localHashMatchesSidecar: false,
        serverHashMatchesSidecar: true,
      }),
    ).toBe("local-ahead");
  });

  it("server-changed + BOTH moved past sidecar -> conflict (real 3-way divergence)", () => {
    expect(
      classifySyncStatus({
        serverStatus: "server-changed",
        hasSidecar: true,
        localHashMatchesSidecar: false,
        serverHashMatchesSidecar: false,
      }),
    ).toBe("conflict");
  });

  it("server unknown -> unknown (sidecar irrelevant; orchestrator refines via get_with_ancestor)", () => {
    expect(
      classifySyncStatus({
        serverStatus: "unknown",
        hasSidecar: false,
        localHashMatchesSidecar: false,
        serverHashMatchesSidecar: false,
      }),
    ).toBe("unknown");
    // Even when a sidecar was present but server returned 'unknown'
    // (unusual but possible), fall through to the refinement step.
    expect(
      classifySyncStatus({
        serverStatus: "unknown",
        hasSidecar: true,
        localHashMatchesSidecar: true,
        serverHashMatchesSidecar: true,
      }),
    ).toBe("unknown");
  });

  it("server not-found -> orphan (regardless of sidecar state)", () => {
    expect(
      classifySyncStatus({
        serverStatus: "not-found",
        hasSidecar: true,
        localHashMatchesSidecar: true,
        serverHashMatchesSidecar: true,
      }),
    ).toBe("orphan");
    expect(
      classifySyncStatus({
        serverStatus: "not-found",
        hasSidecar: false,
        localHashMatchesSidecar: false,
        serverHashMatchesSidecar: false,
      }),
    ).toBe("orphan");
  });

  it("hasSidecar=false collapses every non-orphan server status to 'unknown'", () => {
    // hasSidecar=false means we didn't send a local_hash, so any
    // non-orphan server status MUST have been 'unknown' (server-side
    // bug otherwise). The classifier degrades gracefully.
    expect(
      classifySyncStatus({
        serverStatus: "up-to-date",
        hasSidecar: false,
        localHashMatchesSidecar: false,
        serverHashMatchesSidecar: false,
      }),
    ).toBe("unknown");
    expect(
      classifySyncStatus({
        serverStatus: "server-changed",
        hasSidecar: false,
        localHashMatchesSidecar: false,
        serverHashMatchesSidecar: false,
      }),
    ).toBe("unknown");
  });
});
