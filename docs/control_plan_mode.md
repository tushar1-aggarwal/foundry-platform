# Ark — Context, Goals, and Plan

## 1. The Big Picture

Ark is an autonomous-agent orchestration product. It runs LLM coding agents (Claude Code, Codex, Gemini, Goose) through declarative SDLC flows on top of pluggable compute targets (laptop, docker, k8s, EC2, firecracker, …). The product target is a multi-tenant SaaS control plane that other teams and customers can dispatch agent work onto.

Today the codebase carries **two parallel deployment shapes** for that single product. Only one of them is the goal. The other was a bootstrapping convenience that has outgrown its usefulness and is now a tax on every change.

---

## 2. The Two Deployment Shapes Today

### Local mode — the laptop shape
Designed for a single developer running everything on their own machine. The daemon owns the user's home directory, persists state in a file-based database, stores secrets in a local file, runs agents via tmux on the same host, exposes filesystem-browsing and host-command RPCs to the UI, and uses a custom in-process orchestrator built specifically for Ark.

It works. *Somewhat.* It's homebrew end-to-end — the database, the secrets backend, the orchestrator, the launcher. Everything is bespoke, everything is single-tenant, and none of it is the production target.

### Control-plane mode — the SaaS shape
Designed for multi-tenant hosting. Postgres for state, Redis for events, AWS Secrets Manager for credentials, strict authentication and tenant isolation on every request, no assumption that the daemon has a usable local filesystem, agents execute on remote compute (never on the control plane itself), and Temporal as the orchestrator.

This is the product. This is what gets deployed. This is what customers will use.

---

## 3. Why Two Shapes Is the Problem

The split is *not* a clean abstraction layer — it leaks. Every cross-cutting concern in the system has a "local branch" and a "hosted branch":

- **Persistence:** SQLite vs. Postgres — two schemas, two migration streams, two query dialects.
- **Secrets:** local file vs. AWS Secrets Manager.
- **Tenant scoping:** passthrough vs. real per-request DI scope.
- **Auth:** optional vs. mandatory.
- **Filesystem access:** rich local-FS RPCs vs. none at all.
- **Compute defaulting:** silent fallback to laptop tmux vs. must-name-it-or-fail.
- **Orchestration:** custom homebrew state machine vs. Temporal (in design, not done).

The cost of this split:
- **Drift.** Two implementations of every boundary means two places to fix every bug, and they fall out of sync.
- **False confidence.** Passing every test locally tells you nothing about whether the hosted path works. Local success is not transferable.
- **Maintenance tax on every change.** New handlers, new fields, new flows — all have to consider both modes. Forgetting either is a real defect class (and has been: silent multi-tenant exposure, dialect-specific bugs).
- **Unfinished orchestrator.** The custom orchestrator is mature enough to feel committed-to but still missing the durability and visibility Temporal gives for free. Every hour spent fixing it is an hour not spent on Temporal — and Temporal will replace it anyway.

The goal of the project is not "Ark works on my laptop." The goal is "Ark serves customers at pai-risk-mlops." Local mode is rent paid against a goal that doesn't exist anymore.

---

## 4. The Decision

Stop maintaining local mode. Make hosted mode the only mode. Pay the deletion cost once, then move forward with one path.

Local-on-laptop development still has to be possible — engineers need to be able to run the stack without standing up real cloud infra — but the way it's possible changes. Instead of a code-level "local mode" that simulates a different system, the laptop runs the *real* hosted system inside a Docker Compose stack: Postgres, Redis, Temporal, Ark daemon, all containerized, all on the dev's machine. The daemon doesn't know it's local; from its point of view, it's the hosted control plane talking to real Postgres and real Temporal. There is no local-mode code path to keep alive.

This collapses the two shapes into one. There is one database, one secrets backend, one orchestrator, one auth model, one set of handlers. Every test that passes is testing the production path. Every bug fixed is fixed for production.

---

## 5. The Three Goals

### Goal 1 — Eliminate local mode from the codebase
Strip out everything that exists only to support the laptop-single-user shape. The polymorphic deployment-mode abstraction collapses into a single hosted implementation. The SQLite-specific layers, the file-based secrets, the FS / host-command RPCs, the custom orchestrator scaffolding, the local-only handler registrations, and every test fixture that depends on them — all gone. The Postgres + AWS-secrets + Temporal path becomes the only path.

### Goal 2 — Replace the laptop dev experience with a Docker Compose stack
Provide a one-command developer setup that brings up the full hosted topology on a laptop: Postgres, Redis, Temporal (with its UI), and the Ark daemon, all wired together. This is the new "local development" — same code paths as production, just running in containers on the dev's machine. No more bespoke local-mode behavior to debug.

### Goal 3 — Ship the control plane to pai-risk-mlops
Make the existing Helm chart and Argo CD wiring actually deploy a working control plane to the cluster. The chart is suspected non-functional today; the deployment as a whole has not been run end-to-end. With local mode gone and Temporal as the sole orchestrator, the deployed control plane becomes the system of record. The acceptance bar is: a real session dispatched through the deployed instance, executed on remote compute, orchestrated by Temporal, end to end.

---

## 6. Sequencing

The three goals are dependent in order:

**Goal 1 → Goal 2.** Building a Compose stack around code that's about to be deleted is wasted effort. Local-mode removal happens first so the Compose stack only has to wire up what remains.

**Goal 2 → Goal 3.** The Compose stack is the laptop-scale rehearsal of the production topology. Whatever wiring works in Compose maps almost directly to the Helm chart's service graph. Skipping straight to the cluster deploy means debugging unfamiliar wiring under unfamiliar infra simultaneously, which is the slowest possible path.

**Goal 3 is the actual deliverable.** Goals 1 and 2 are de-risking. The product ships when a customer-grade session runs on the deployed control plane.

---

## 7. What Changes Conceptually After This

- **One deployment shape, not two.** The codebase no longer asks "am I local or hosted?" The question is gone.
- **One orchestrator.** Temporal replaces the custom state machine entirely. Durable workflow history, visibility, retries, and failure handling come from a system designed for it instead of being reinvented. Bugs in the homebrew orchestrator are no longer worth fixing — that code is going away.
- **One source of confidence.** Passing tests on a developer laptop means passing tests against the production stack, just on smaller hardware.
- **One thing to operate.** A single Helm chart, a single set of services, a single auth and tenancy model.

---

## 8. What This Project Is Not About

To keep scope honest:

- Not a refactor for elegance. The goal is removing a parallel implementation, not redesigning the remaining one.
- Not a feature push. No new flows, agents, runtimes, or compute providers come in under this work.
- Not a UX project. The web dashboard, the CLI surface, the JSON-RPC API — all stay the same from the outside. What changes is what's behind them.
- Not a migration of customer data. There are no production users on local mode; there is nothing to migrate.

The win condition is narrow and concrete: one deployment shape, running on Docker Compose for dev and on the cluster for prod, with Temporal as the orchestrator, deployed and serving sessions in pai-risk-mlops.
