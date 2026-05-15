# Skill Hub — test plan

Companion to the implementation. Describes what was tested, how it was
tested, and what coverage gaps remain. Reviewers and future maintainers
should be able to read this once and know where the confidence comes
from on each surface.

---

## 1. Coverage matrix

| Surface | Unit tests | CLI live e2e | Dashboard live e2e | Real LLM merge |
|---|---|---|---|---|
| **Schema + migrations** (`022_skills_*`) | ✓ migration-runner + snapshot tests | ✓ exercised by every live `put` | n/a | n/a |
| **`SkillRepository`** (CRUD, listVisibleTo, listAllInTenant, put-CAS, softDelete) | ✓ 881-line test file pins every visibility / scope combo | ✓ via live put / list / delete | ✓ admin/list rows | n/a |
| **`SkillVersionRepository`** (getByHash, listBySkill) | ✓ | ✓ via dashboard drawer | ✓ history rendering | ✓ MERGED row written |
| **Canonical hashing + normalizer** | ✓ idempotency + cross-platform | ✓ via `install` round-trip (hash byte-identical) | n/a | ✓ pre + post merge |
| **Conductor handlers** (`skillhub/*`, `admin/skillhub/*`) | ✓ 1148-line test file: role gates, visibility, existence-leak defense, CAS conflict | ✓ all happy paths | ✓ admin endpoints | ✓ merge_input passthrough |
| **Adapters** (claude / cursor / codex) | ✓ per-adapter test files | ✓ all 3 adapters live (parse, render, sidecar routing) | n/a | claude only |
| **CLI commands** (list / get / put / delete / sync / install / search) | ✓ pure-helper tests (classify, buildPutParams, findLocalSkillBundles, assertSkillDirNameMatchesFrontmatter, etc.) | ✓ all 7 commands run live | ✓ delete via dashboard | sync only |
| **CLI flags** (`--harness`, `--dir`, `--dry-run`, `--no-merge`, `--yes`, `--force`, `--visibility`, `--team`, `--tag`, `--description`, `--category`) | ✓ classify / wiring helpers | ✓ all exercised | n/a | `--yes` confirmed |
| **Sidecar I/O + gitignore warning** | ✓ | ✓ create / read / delete / orphan-cleanup / write-time gitignore warning | n/a | n/a |
| **Merge engine** (`clientSideMerge` + injectable LLM) | ✓ 459-line test: per-file strategies, asymmetric modify/delete, ancestor-resolution, normalize-after-merge | ✓ single-file 3-way; multi-file partial-merge (M8 boundary) | ✓ merge_input rendered | ✓ end-to-end via Claude Sonnet 4.6 |
| **Credential discovery** (`discoverAnthropicCredentials`) | ✓ env-api-key, env-oauth-token, ark-secrets, error-message paths, default-name regex pin | ✓ OAuth path via macOS keychain | n/a | ✓ |
| **Auth + `actorIdentity`** (multi-handler fix) | ✓ auth-whoami + skill-handler + admin-scoping regression tests | ✓ auth-required mode with user-bound API key | n/a | n/a |
| **Web dashboard** (Skills tab + audit drawer) | ✓ react components compile clean, types match wire shape | ✓ via puppeteer (table render, row click → drawer, version history, merge_input_json blob, delete confirm w/ cancel + accept) | n/a | n/a |

---

## 2. Live e2e — what we actually ran

Two test environments:

### 2.a Ark's own repo (controlled e2e)

- Fresh `~/.ark` wipe + daemon restart
- Bootstrap: tenant `default`, team `platform`, three users (alice / bob / carol), API keys minted per role and bound to user_ids via direct sqlite UPDATE
- Daemon flipped to `ARK_AUTH_REQUIRE_TOKEN=true`
- Exercised: auth gate, all visibility scopes (user/team/tenant), list filtering by role, existence-leak defense, role-based delete refusal, full LLM merge with Claude Sonnet 4.6 via OAuth, dashboard rendering
- Full transcript: `~/e2e-out/cli-log.txt`

### 2.b Downstream consumer repo (`pi-feature-store-registry`)

A real Paytm repo with pre-existing `.claude/skills/*` content. Tested
the "user setting up Skill Hub for the first time" flow:

- Bootstrap a user + bind a key (the "proper path" walkthrough)
- Author a `merge-demo` skill, upload, edit, re-upload
- Trigger a 3-way merge via sidecar-rewind, run sync with `--yes`,
  verify Claude produced a clean merge that kept both branches' edits
- Walk every CLI flag combination (16 gaps from the coverage matrix)

This second environment is what surfaced the production-impacting bugs
listed in §4 below — none of which had unit-test coverage pre-fix.

### 2.c Real LLM merge — proof artifact

The 3-way merge ran end-to-end via `@anthropic-ai/claude-agent-sdk`
against `claude-sonnet-4-6` using the Claude Code Max OAuth token from
the macOS keychain. The merge_input audit blob on the resulting
`skill_versions` row:

```json
{
  "ancestor_hash": "38ad0c7ee974...",
  "mine_hash":     "24904fabf0d8...",
  "theirs_hash":   "d385ba7293bf...",
  "llm_model":     "claude-sonnet-4-6",
  "per_file_strategies": { "SKILL.md": "llm" },
  "accepted_by":   "cli"
}
```

The dashboard's Skills tab renders this blob pretty-printed in the
audit drawer; the row's "MERGED" badge distinguishes LLM-produced
versions from direct edits.

---

## 3. Gap matrix — what was NOT tested live

| Surface | Status | Risk if unexercised |
|---|---|---|
| **Multi-tenant cross-tenant isolation** | Unit-test only | NONE — by design. v1 has no user-reachable path to create a second tenant (tenant create is gated to a system-admin role that doesn't exist in v1, per PR #568). The cross-tenant boundary IS covered by handler unit tests using `AppContext.forTestAsync()` to seed multi-tenant fixtures, but it's not reproducible end-to-end via CLI. |
| **Multi-file LLM merge** | Live: single-file only | **Medium — parked.** Multi-file skills (SKILL.md + supporting scripts/configs) hit the "partial merge" hole described in §5. SKILL.md merges successfully via LLM, but if any supporting file requires manual resolution, sync refuses to push and the in-memory merged content is discarded. Documented as M8; deliberately not fixed in v1. |
| **Sync's `--prune-orphans` auto-cleanup** | Manual cleanup only | Minor UX — orphan sidecars require `rm` to clear; the CLI surfaces them as warnings. Future enhancement, not blocker. |
| **Discovery banner with cursor / codex authors** | Live with claude only | Low — same code path, just different harness label. |
| **Bootstrap-admin CLI** | Doesn't exist | Low — replaced by direct sqlite UPDATE in the e2e. Phase 3 follow-up. Not in this PR. |

---

## 4. Bugs surfaced by live testing — all fixed inline

Each was a real user-facing bug with no pre-fix unit-test coverage.
Live testing was the only way they would have surfaced before users hit
them. All have regression tests landed in this PR.

| # | Bug | Found by | Fix |
|---|---|---|---|
| 1 | Skill-Hub `owner_user_id` / `created_by` / `changed_by` were storing the api-key sentinel (`ak-*`) instead of the real user id | C17 dashboard exposing the audit drawer | Centralized `actorIdentity(ctx)` helper in `core/auth/context.ts`; updated 6 other handler sites (Yana caught the bug class) |
| 2 | Sidecar dir not gitignored by default in downstream consumer repos | First `ark skills put` in `pi-feature-store-registry` | Ark's root `.gitignore` updated + write-time warning helper in `state.ts` |
| 3 | `ark skills delete` left a stale sidecar; subsequent `put` failed `NOT_FOUND` | Delete → put cycle | `delete` sweeps matching sidecars; `put` auto-recovers from stale state with a one-step retry hint |
| 4 | Directory name vs frontmatter `name:` could desync silently (`put` accepts, `sync` fails) | After renaming local skill dir | `put` enforces dir-name == frontmatter-name with both-side remediation hints |
| 5 | Classify confused "local-ahead" with "conflict" when local moved but server hadn't | Plain edit-then-sync | Added `serverHashMatchesSidecar` bit to `classify`; distinguishes "only local moved" from "both moved" |
| 6 | `--no-merge` flag silently ignored (commander naming mismatch) | Trying to suppress LLM call without credentials | Renamed `noMerge` → `merge` to match commander's `--no-X` negation convention |
| 7 | Merge-auth secret name regex collision (default was lowercase-hyphenated, store requires `[A-Z0-9_]+`) | Stack walk before merge could run | Renamed default to `SKILLHUB_ANTHROPIC_TOKEN`; pinned by regression test |
| 8 | Claude Code Max users locked out of the merge (`auth.ts` falsely claimed SDK doesn't accept OAuth) | Trying to use Claude Code subscription as credential | Made `CLAUDE_CODE_OAUTH_TOKEN` a first-class discovery path; threaded `CredentialKind` through `buildClaudeAgentMergeFn` |
| 9 | `ark skills sync` had no `--yes` flag; non-TTY callers hard-failed | Pipe-into-stdout invocation during e2e | Added `--yes`; threaded through both interactive prompts in `handleConflict` |
| 10 | CRLF SKILL.md silently dropped frontmatter | Defensive (Windows author scenario) | `parseFrontmatter` normalizes line endings + emits specific errors for missing markers |
| 11 | Local-mode user-scope put gave confusing service-api-key error | First put in local mode without auth | Error message distinguishes local-mode vs service-api-key vs anonymous |
| 12 | 004_soft_delete snapshot test missed three new `idx_skills_*_name_live` indexes | First full-suite run after migration 022 | Snapshot updated inline; included as part of the migration commit |

The 12 fixes are spread across the implementation commits (each fix
landed with the regression test that pins it). For PR review, the
adversarial-test pass that surfaced them was the highest-yield
exercise of the entire feature.

---

## 5. Parked items (deferred to follow-up)

| Item | Why parked | Tracking |
|---|---|---|
| **M8 — multi-file partial-merge "lost work"** | Successful LLM merge of `SKILL.md` is discarded when ANY supporting file requires manual resolution. Re-running sync re-invokes Claude (cost + non-deterministic output). Fix is ~40-60 LoC across `clientSideMerge` + `handleConflict`. See M8 detail below. | Follow-up PR |
| **Bootstrap-admin CLI** | Until it exists, binding api-keys to user identities requires a direct sqlite UPDATE. e2e mirrored what the CLI will eventually do. | Phase 3 follow-up |
| **Cross-tenant skill visibility** | RFC §9 Q1 — strict isolation decision. `cross_tenant` visibility is reserved but `skillhub/put` rejects it in v1. When system-admin role lands, a one-PR enablement adds the partial unique index and unblocks the writes. | Phase 3 follow-up |
| **Cursor pagination on `admin/skillhub/list` + `version_history`** | Both endpoints return the full set today. v1 tenant skill counts are <100; pagination becomes interesting when populations grow. | Tracked as cursor-pagination follow-up |
| **Tombstone GC for old soft-deleted skills** | `skill_versions` history persists indefinitely. A periodic compactor would clear histories of long-deleted skills. | Tracked as tombstone-GC follow-up |
| **`ark skill` (singular) vs `ark skills` (plural) namespace unification** | The two flavors of skill coexist intentionally per RFC §1. Consolidating under a single command surface is non-trivial (different storage backends, different lifecycles). | Tracked as namespace-unification follow-up |

### M8 detail — why deferred + the three design decisions

**Why deferred (vs. fixing inline before this PR ships):**

The bug fires only under a specific conjunction:

1. Multi-file skill (SKILL.md + at least one supporting file), AND
2. At least one supporting file is non-markdown (`.py`, `.sh`, `.json`, `.yaml`, etc. — these default to `manual` strategy, no LLM attempt), AND
3. Both branches edited the SAME non-markdown file with different content, AND
4. The skill is in a true 3-way state (not local-ahead, not fast-forward-pull).

Single-file skills (the most common shape in early adoption) never trigger it. Multi-file skills with only markdown supporting files never trigger it (everything's LLM strategy — either all merge or all fail together). The canonical deploy-runbook-with-scripts case IS realistic but requires concurrent multi-author edits to the same script file.

**Blast radius when it does fire:**

- **No data loss at the storage layer.** Server's `current_hash` and `skill_versions` are untouched (sync refused to push). Local files keep their pre-merge "mine" state.
- **Cost: ~$0.03-0.05 per LLM call wasted on retry.** Claude Sonnet 4.6 input is ~5-20KB; cumulative impact on a team is bounded by edit frequency.
- **Output non-determinism on retry.** Re-running sync re-invokes Claude. The second merge's `SKILL.md` may differ from the first (LLM temperature ≠ 0). Subtle.
- **Workaround exists.** `--no-merge` resolves everything manually — defeats the feature's value but doesn't block work.

**Rough usage estimate for the internal pilot:**

Skills with non-markdown supporting files: ~30-50% of authored skills based on the deploy-runbook pattern. Concurrent same-file edits across authors: probably 1-5% of those, weighted by team size and skill churn. So a 20-person team writing 50 skills hits ~1-3 partial-merges/month. Each is ~$0.05 wasted + a confused user. Annoying, not catastrophic.

**Why not fix inline:**

The fix needs three load-bearing design calls (below) — none mechanical. Rushing them risks landing a half-thought-through behavior that becomes a different long-tail bug. Internal pilot is the right surface to learn from before committing to the design.

---

The fix is ~40-60 LoC across `clientSideMerge` + `handleConflict`. Three load-bearing design choices to make before implementing:

**1. Where to persist the proposed merge**

Two shapes that both work:

- **(a) `.proposed-merge` suffix in-place.** Write merged files at their normal path; for files that need manual resolution, write the raw three-way as a sibling file (e.g., `scripts/check.sh.proposed-merge`). Visible to the user's editor; they resolve, delete the suffix file, re-run sync.
- **(b) State file under `<repo>/.ark/skills-state/<harness>-<name>.proposed.json`.** Stash the full `proposed_merge` blob. Invisible to the editor; next sync detects it and consumes (skipping LLM re-call for files already merged).

Tradeoff: (a) is discoverable — users see the conflict in their editor without reading docs. (b) is less intrusive but harder to find. Lean: (a).

**2. Re-validation on resume**

When the user re-runs sync and finds either the suffix files or the proposed.json blob, do we (i) trust the cached state and skip the LLM call, or (ii) re-validate against the current `server.current_hash` first?

The concern: server may have moved between the first sync attempt and the resume. The cached merge's `theirs` is now stale. Trusting it would silently push an out-of-date merge.

Lean: (ii) re-validate. If `server.current_hash` differs from the cached `theirs_hash`, throw the cache away and re-merge.

**3. Sweep policy for dangling proposed-merge artifacts**

If the user resolves manually without going through sync (e.g., just deletes the `.proposed-merge` file and writes the real one), the next sync sees orphans. Two options:

- **Sweep on next sync.** Any `.proposed-merge` file whose paired primary file has been resolved gets deleted. Aggressive; could surprise a user who's mid-edit.
- **Leave alone.** Documented as a manual cleanup task. Less surprise; more clutter.

Lean: sweep on next sync, but only when the primary file has changed since the proposed-merge was written (mtime check). That covers the "user resolved + moved on" case without nuking in-progress work.

These three calls are the non-trivial part; the code that follows the calls is mechanical. Worth a 15-minute design-review conversation before writing.

---

## 6. How to reproduce the live e2e

Two reproducible paths. The first is the controlled walkthrough; the
second exercises a downstream consumer's workflow.

### 6.a Controlled e2e in Ark's own repo

```bash
# Wipe + start fresh
ark server daemon stop && rm -rf ~/.ark && ark server daemon start

# Bootstrap
ark tenant list                       # confirm default tenant
ark team create platform --tenant default --name Platform
ark user create --email you@paytm.com --name "You"
USER_ID=$(ark user list 2>&1 | grep you@paytm.com | awk '{print $1}')

# Mint + bind admin API key
ark auth create-key --tenant default --role admin --name personal > /tmp/k.out
KEY=$(grep Key: /tmp/k.out | awk '{print $NF}')
sqlite3 ~/.ark/ark.db "UPDATE api_keys SET user_id='$USER_ID' WHERE name='personal';"

# Flip auth on
ark server daemon stop
ARK_AUTH_REQUIRE_TOKEN=true ark server daemon start &
export ARK_TOKEN=$KEY

# Exercise the surface (CLI + dashboard + real LLM merge)
# See §6.b for the merge-demo walkthrough
```

### 6.b Downstream consumer flow + real LLM merge

```bash
# In any repo (e.g. ~/IdeaProjects/<your-app>)
cd ~/work/my-app

# Author a skill
mkdir -p .claude/skills/merge-demo
cat > .claude/skills/merge-demo/SKILL.md <<EOF
---
name: merge-demo
description: Test 3-way merge
---
# merge-demo
Steps:
1. Tag  2. Smoke  3. Promote
EOF
ark skills put .claude/skills/merge-demo --visibility tenant

# Add the gitignore exclusion the warning asked for
echo ".ark/skills-state/" >> .gitignore

# Push v2 from "the server's side"
# (edit body to add 'Run security scan', then put)
ark skills put .claude/skills/merge-demo

# Capture v1's hash, rewind sidecar
V1_HASH=$(sqlite3 ~/.ark/ark.db "SELECT version_hash FROM skill_versions WHERE changed_at = (SELECT MIN(changed_at) FROM skill_versions WHERE skill_id = (SELECT id FROM skills WHERE name='merge-demo'))")
jq --arg h "$V1_HASH" '.current_hash = $h' .ark/skills-state/claude-merge-demo.json > /tmp/x && mv /tmp/x .ark/skills-state/claude-merge-demo.json

# Local v3 (edit body to add a different step)

# Extract Claude Code Max OAuth + run merge
export CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w | jq -r '.claudeAiOauth.accessToken')
ark skills sync --yes

# Verify
cat .claude/skills/merge-demo/SKILL.md     # merged body
sqlite3 ~/.ark/ark.db "SELECT version_hash, CASE WHEN merge_input_json IS NULL THEN 'direct' ELSE 'MERGED' END FROM skill_versions WHERE skill_id IN (SELECT id FROM skills WHERE name='merge-demo')"
```

### 6.c Dashboard verification

```bash
ark web --port 8420 &
open http://localhost:8420/#/admin    # Skills tab → click row → audit drawer
```

---

## 7. Test outcome (final)

| Suite | Result |
|---|---|
| `make test` | **5692 pass / 0 fail / 7 skip** across 555 files |
| `make lint` | clean |
| Live CLI e2e (16 gaps + bootstrap walkthrough) | ✓ all green |
| Live UI e2e (puppeteer) | ✓ table render + audit drawer + merge_input rendering + delete confirm |
| Real LLM 3-way merge (CLI + dashboard) | ✓ `claude-sonnet-4-6` via Claude Code Max OAuth |
