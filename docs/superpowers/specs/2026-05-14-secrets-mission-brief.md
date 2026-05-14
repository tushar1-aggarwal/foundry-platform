# Hierarchical Secrets -- Mission Brief (for Ark sessions)

> **Audience:** an Ark agentic session picking up this branch (`feature/secrets-management-revisions`). This brief is the entry point. The heavy design + per-task instructions live in the linked artifacts; read them in the order below.

## Mission

Build Ark's **hierarchical secrets manager** -- `tenant -> team -> user` scope, encrypted at rest, capability-authorized, audit-logged. v1 ships through AWS SSM only. The full design is already complete and advisor-reviewed; this branch is the implementation runway.

## Canonical artifacts (read in this order)

| # | Path | Why |
|---|---|---|
| 1 | `docs/superpowers/specs/2026-05-13-hierarchical-secrets-design.md` | Authoritative design. Defines schema, resolution algorithm, encryption envelope, capability model, audit log, onboarding wizards, phasing. |
| 2 | `docs/superpowers/specs/2026-05-14-ssm-kek-backend.md` | Addendum that **supersedes D5/D20** -- v1 master KEK lives in AWS SSM, not env. `KekBackend` interface is introduced in v1. |
| 3 | `docs/superpowers/specs/2026-05-13-hierarchical-secrets-flow.md` | Sequence diagrams (creation / retrieval / dispatch). |
| 4 | `docs/superpowers/specs/2026-05-14-hierarchical-secrets-lifecycle.md` | End-to-end mermaid lifecycle. |
| 5 | `docs/superpowers/plans/2026-05-14-ssm-kek-backend.md` | **First implementation plan.** Task-by-task checklist + acceptance criteria. This is what the agent executes. |

## This session's scope (Phase 1: KEK seam only)

**Execute `docs/superpowers/plans/2026-05-14-ssm-kek-backend.md` task-by-task.** Delivers:

- New `packages/secrets/` workspace package (kek-only for now).
- `KekBackend` interface + `SecureBuffer` + `KekLoadError`.
- `SsmKekBackend` -- single `ssm:GetParameter WithDecryption=true`, base64-decode to 32 bytes, validate, wrap in `SecureBuffer`.
- `loadMasterKey(config)` factory selected from `ARK_KEK_BACKEND=ssm` (only option in v1).
- Wired into `AppContext.boot()`: eager load, fail-fast on misconfig.
- Tests: `bun:test` units for `SecureBuffer` and `SsmKekBackend` (mocked SSMClient), LocalStack-backed integration (skip-when-no-docker), `loadMasterKey` factory selection, and an arkd boot smoke test.

## Out of scope (explicit non-goals for this session)

Do not pull these forward; each gets its own plan/session:

- Per-tenant DEK module + `tenant_deks` table.
- AES-256-GCM cipher with AAD discipline.
- Resolver / `placeAllSecrets` integration.
- HTTP routes, CLI onboarding wizards, audit-log writers.
- KEK rotation tooling.
- BYOK per-tenant.
- Web UI surface for secrets management.
- Any change to `docs/architecture.md` or `docs/ark-brief.md` (track as follow-up).

If a task in the plan tempts you toward any of these, stop and surface it -- do not silently widen scope.

## Operating rules

- **Use the `superpowers:subagent-driven-development` skill** (or `superpowers:executing-plans` if running solo). The plan is structured for it: checkbox tasks, atomic commits, verification per task.
- **Atomic commits, one per task.** Commit message format: `feat(secrets): <task summary>` or `test(secrets): ...`. Co-author lines preserved per repo convention.
- **Bun + ESM + `.js` extensions** in imports (see `CLAUDE.md`).
- **No em dashes** anywhere in code or docs.
- **`make format && make lint && bun test packages/secrets/`** must be green before claiming a task complete. Run before each commit.
- Use **TodoWrite** to mirror the plan's checkbox tasks; mark `in_progress` before starting and `completed` immediately after the verification commands pass.

## Acceptance criteria (mirror of the plan)

Treat these as the definition of done for the session:

- `bun test packages/secrets/` green.
- `make test` green (no test requires real AWS or LocalStack to pass).
- `make format && make lint` green.
- arkd refuses to boot if `ARK_KEK_BACKEND` missing or `ARK_KEK_SSM_PARAMETER` unset, if SSM lookup fails, if value isn't base64, or if decoded bytes != 32.
- Error messages contain parameter name + AWS error code, **never any byte of (partial) key material**.
- `SecureBuffer` zero-fills on `dispose()` / shutdown.
- Setting `ARK_MASTER_KEY` env var emits a warning but does **not** fail boot (env path is gone in v1; warning eases migration).
- `KekBackend` is the only public seam consumed by downstream code; nothing imports `SsmKekBackend` directly except the factory.

## Stop conditions (surface to human before continuing)

- Any task uncovers a spec ambiguity not resolved by reading docs #1-#5.
- A test requires a design choice that contradicts the design or addendum.
- A library / dep needs to be added beyond `@aws-sdk/client-ssm` (already a root dep).
- Test coverage drops or `make test` reveals a regression outside `packages/secrets/`.
- Verification command output is unclear; do not claim success on ambiguous output.

## After this session

Hand off to the next plan (per-tenant DEK + cipher). Update this branch's HANDOFF state with:

- Commits added (one per task).
- Acceptance criteria check results.
- Any intentional deviations (the plan already lists one: `backend.contract.test.ts` is deferred until a second backend lands).
- Anything that surfaced as a follow-up.

The plan's "Follow-ups (NOT in this plan)" section is the queue for subsequent sessions; do not start any of them here.
