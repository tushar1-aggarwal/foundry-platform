# PLAN: Update CHANGELOG.md with recent main-branch changes

## 1. Summary

The most recent CHANGELOG entry is **v0.21.41 (2026-05-05)**. Since that cut, **130 commits** have landed on `main` (today is 2026-05-08). They include genuinely user-visible changes (a CLI command rename, an env var rename, several removed features, observable bug fixes) plus a large amount of pure internal restructuring (conductor/server package merge, arkd `client`/`server`/`common` split, dead-code removal). The changelog entry must surface only what a user running ark would notice or have to act on. Internal refactors with zero observable impact are dropped, not summarized.

The task is to add **one new entry** at the top of `CHANGELOG.md` written in user-facing language, following the rules in section 3 below. Version: **v0.22.0**, dated **2026-05-08**, because the entry contains breaking renames (`ark daemon` -> `ark conductor`, `ARK_SERVER_PORT` -> `ARK_CONDUCTOR_PORT`) and removed features. Bumping `package.json` is **out of scope** -- this task only touches `CHANGELOG.md`.

## 2. Files to modify/create

- `CHANGELOG.md` -- prepend a new `## v0.22.0 (2026-05-08)` section above the existing `## v0.21.41 (2026-05-05)` section. No other files in this section are touched.
- `PLAN.md` -- this planning artifact, committed on the branch.

No code, no schema, no tests.

## 3. Implementation steps

### 3.1. Style rules (read first; apply to every entry)

These rules are non-negotiable. Reread them between writing each section.

1. **Lead with the user-visible behaviour, not the system that changed.**
   - Bad (commit-message style): `fix(compute): rehydrate handle methods after JSON round-trip`
   - Good (user-facing): `Fixed: multi-stage flows could fail on the second stage with "no spawnProcess on its handle" after a daemon restart -- compute handles now survive restarts cleanly.`
2. **If a commit has zero observable user impact, drop it.** Pure internal refactors, type-only cleanups, test-only changes, comment edits, audit-snapshot regenerations, and CI-internal changes do not appear in the changelog.
3. **Call out the migration step explicitly** whenever a user has to change something (rename a command, change an env var, update a YAML key, swap a CLI flag).
4. **PR numbers go in parens at the end of the entry, not as the headline.** Example: `... single conductor process now. (#530)`. If a change spans multiple PRs, list both: `(#529, #530)`. If no PR is associated, omit.
5. **Use `--` (double dash) for em-dash effect.** Per `CLAUDE.md`: never use U+2014 em dashes.
6. **Active voice, present-tense user-facing prose.** "Fixed: X happened. Now Y." Not "X was fixed via Y refactor."
7. **One sentence per entry.** If you need a second clause, use a hyphen, semicolon, or parenthetical -- not a second sentence with a period.
8. **Match the existing header taxonomy** used in v0.18.0 and earlier: `### Breaking changes`, `### Removed`, `### Changed`, `### Features`, `### Fixes`. Pick the most specific bucket and don't invent new headers.

### 3.2. Source of truth

Run, do not infer:

```bash
git log --oneline 9a3513da..HEAD                              # 130 lines
git log --oneline 9a3513da..HEAD --no-merges                  # exclude merge noise
git show --stat <hash>                                        # check blast radius before deciding
```

`9a3513da` is the commit that added the v0.21.41 entry; `HEAD` is `f7d10501`. Anything in that range is a candidate for the new entry. Anything outside it is already covered.

### 3.3. Entry-by-entry decisions (concrete keep/drop list)

The list below is the planner's classification of every notable commit in `9a3513da..HEAD`. The implementer must verify each line against the actual commit before pasting (commit messages occasionally undersell or oversell impact). Drafted text is offered as a starting point, not a final wording -- adjust based on what `git show <hash>` actually changed.

#### KEEP -- Breaking changes (user must update something)

| Source commits | Drafted entry |
|---|---|
| `012ade06`, `e807b99b`, `7115529b`, `f98950af`, `276c1b42`, PR #530 | `**Renamed: `ark daemon` is now `ark conductor`.** The conductor and server daemon are a single process; old subcommands (`start`, `stop`, `status`) live under `ark conductor` now. Update any scripts or systemd units that called `ark daemon`. (#530)` |
| `f0614ffb`, `267751bf`, `596c0d92`, `28bc7fdc` | `**Renamed env var and YAML key: `ARK_SERVER_PORT` -> `ARK_CONDUCTOR_PORT`, `ports.server` -> `ports.conductor`.** The legacy aliases are removed (no soft fallback). Update any deployment configs that set them. (#530)` |
| `9bdfa993`, `b44d692b` | `**Removed: `--provider` flag on `ark compute create`.** Use `--kind` (e.g. `docker`, `ec2`) and `--isolation` (e.g. `firecracker`, `kata`) instead. (#529)` |
| `654c43b5` | `**Removed: `arc.json` workspace config file.** Compute port discovery now happens inside the isolation layer; delete any leftover `arc.json` files from your repos -- they are no longer read. (#529)` |
| `85f9794b`, `91ac3185` | `**Changed: runtime-specific fields now nest under `runtime_config:` in agent and runtime YAML.** Top-level placement still loads but is no longer the canonical shape; migrate definitions to the nested form.` (Verify whether the old shape is fully removed or just deprecated; check `git show 85f9794b` for the schema diff before committing to wording.) |

#### KEEP -- Removed features (rare-but-real users will notice)

For each: the implementer must verify with `git show <hash>` that the feature is fully removed (not just relocated). If the feature is relocated, it belongs under "Changed", not "Removed".

| Source commits | Drafted entry |
|---|---|
| `4f15b19d` | `**Removed: ACP headless JSON-RPC server.** Unused. If you depended on it, file an issue.` |
| `7b434575` | `**Removed: `mcp/attach` and `mcp/attach-by-dir` JSON-RPC methods (and the underlying `McpDirCapability`).** Unused.` |
| `85fd761e`, `0e3687db` | `**Removed: `ark recipe` commands and the recipe feature.** Unused. Recipes that lived in `recipes/` are no longer loaded; move any custom flows to skills or agent definitions.` |
| `85fd761e` | `**Removed: skill-extractor (auto-extract reusable procedures from completed sessions).** Unused.` |
| `e91cec06`, `29e0069e` | `**Removed: code-intel / knowledge graph / repo-map.** Superseded by the workspaces package; `ark knowledge ...` commands no longer exist. Workspace indexing remains.` |
| `e91cec06` | `**Removed: code search and the History view in the TUI/web UI.** Unused.` |

> Cross-check: confirm via `git log --oneline -- packages/core/knowledge/ packages/core/code-intel/` that these directories are actually gone in `HEAD`. If the deletion only happened on a feature branch and was reverted, drop the entry.

#### KEEP -- Changed (observable behaviour shift, no user action required)

| Source commits | Drafted entry |
|---|---|
| `1aa2f3fa` | `**Changed: OpenAI-compatible proxy, webhook, and health endpoints now served on the conductor port** (previously a separate server port). External integrations pointing at the old port will need their URL updated; see `### Breaking changes` for the env-var rename.` |
| `c7c1a71a`, `444e7a77` | `**Changed: role-gated JSON-RPC errors now describe the required role** instead of returning an opaque "forbidden" -- e.g. "method `worker/register` requires role `worker`, got `viewer`".` |
| `cd8ae046`, `d276d0a0` | `**Changed: web UI realtime updates unified onto a single SSE primitive.** Reconnection churn during long sessions should be lower; if you observe new push-stream regressions, this is the candidate area.` |

#### KEEP -- Features (new capability)

| Source commits | Drafted entry |
|---|---|
| `e701d8a4`, `471a8f7f`, `551dd678`, `0ef218b9`, `5e8a1fa2` | `**New: live log and terminal subscriptions, session-tree push, session forensics view.** The web UI now streams session log lines and tmux output via JSON-RPC subscriptions; a "Forensics" panel surfaces post-mortem state for completed/failed sessions. (#530)` |
| `d4b7703a` | `**New: post-launch operations on `AgentHandle` and `ComputeHandle`.** Programmatic users (SDK / scripts) can now restart, snapshot, and inspect a running agent or compute target after launch -- previously these handles were write-once. (Verify the public API in `git show d4b7703a` and reword if the surface is still internal.)` |

#### KEEP -- Fixes (each must describe the symptom, not the diff)

For each: rewrite **the commit message subject** into the user-visible symptom that this fixed. The drafts below are starting points; the implementer should grep for issue numbers / PR descriptions when the symptom is unclear.

| Source commits | Drafted entry |
|---|---|
| `73fcedee` | `Fixed: multi-stage flows could fail on the second stage with "no spawnProcess on its handle" after a daemon restart -- compute handles now survive JSON round-trips cleanly.` |
| `b8d036e7` | `Fixed: archived sessions could be revived back to "ready" by hook events that arrived after archiving (delayed agent reports). Archived sessions now stay archived.` |
| `bcc09712` | `Fixed: PR creation could fail with "non-fast-forward" if the branch already existed on the remote -- the create-pr action now auto-renames the branch with a suffix and retries.` |
| `1aec9758` | `Fixed: auto-renamed branches had a redundant `-s-` in the suffix (e.g. `feature-s-2`) -- now just `feature-2`.` |
| `34d39133` | `Fixed: `arkd` `/exec` requests that hit the timeout could leak processes; the timeout path now sends `SIGKILL` and drains stdout/stderr with a bound.` |
| `8815837d` | `Fixed: creating a session without specifying compute could persist a non-null compute_name at the database layer; the default is now applied at the service layer and the column accepts null.` |
| (none new since v0.21.41) | -- The other fix-flavoured commits since 9a3513da (`fix(test): reset process.exitCode...`, `fix(arkd): update import paths after split`, `fix(infra): point arkd-launcher at merged URL`, `fix(server): role-gating error messages descriptive` -- already covered above) are either test-only or already accounted for. |

#### DROP -- No user impact (do NOT add to changelog)

These are listed so the implementer doesn't go hunting for them or feel they were missed. The reason for dropping is in the right column. **Do not paraphrase any of these into the changelog.**

| Source theme / commits | Why dropped |
|---|---|
| Conductor/server package merge file moves -- `e807b99b`, `f98950af`, `276c1b42`, `7115529b`, `5a38a1dc`, `863d7acf` | Internal restructure. The user-facing piece (CLI rename, port merge) is already covered under `### Breaking changes`; the "we moved code from `packages/core/conductor/` into `packages/server/`" piece is invisible to anyone not editing the source. |
| arkd internal split -- `c3b89eb9`, `f0311621`, `63889c7a`, `c809018b`, `2c746cab`, `a6b4bf69`, `38ab4310`, `d8c18032`, `3e4e3e24`, `2e819152`, `9e3e2832`, `1344f595`, `c99896d3`, `832e9eef` | Pure source layout. ESLint boundary, sub-path entry points, common/client/server barrels -- no public API change, no behaviour change. |
| Workspace package promotion -- `d75205cd`, `8e833c55`, `5e4a9a11`, `2e21aebc`, `4e555eb2`, `56e81f52` | Internal package boundary; consumers import the same names. |
| Dead-code mass removal -- `57ca3665` (30 files), `c396826e` (hex/ports), `6a53aea0`, `c517c0c2`, `3cb8a882`, `d166d9fb`, `b3cad54c` | Internal. The *features* removed are listed individually under `### Removed` above; the file-level deletions are not separately user-visible. |
| Dissolve `packages/core/state/` into `services/` -- `fa445960`, `286db29a` | Internal. |
| Drop ToolDriver abstraction -- `37dea5d0`, `3342ba3d` | Internal. |
| knip CI scan -- `9a7c4f7b`, `a990333e` | CI-only. |
| Trim CI surface, ubuntu migration, serialize releases -- `cd962037`, `529b60fa`, `fb6e5f31` | CI-internal. |
| `pi-tfy` Makefile target -- `eed48f79` | Local dev convenience for one team's pipeline; not a product feature. |
| CLAUDE.md condensed; CLAUDE.md origin note -- `2219fc70`, `65a5630c`, `0aa3cbbf`, `56e81f52` | Doc maintenance. |
| Audit snapshot regenerations -- `db7e33f3`, `3c65e71e`, `9a17a84e`, `953f2343` | Bookkeeping. |
| Test fixes / additions / waitFor bumps / dropped flakes -- `f7d10501`, `fed502d2`, `96400e59`, `9e58a6a8`, `6c4ec8ba`, `36c5b2bb`, `3ba97792` | Test-only; no production behaviour change. |
| Spec/plan/docs adds -- `fe4f3b80`, `131b50c0`, `df00d3dd`, `14852cf1`, `ae0b5a41`, `24124eb7`, `ee165d4f`, `a06faedc`, `74181ae4`, `04c1321e` | Docs-only. |
| `local-e2e-v13-quick-flow (#465)` -- `4d71042a` | E2E artefact; verify with `git show` that no production code changed. If it touched production, promote into the appropriate bucket. |
| Type plumbing follow-ups (`91ac3185` re-application is part of `85f9794b`) | Already covered under runtime_config breaking change above; do not list twice. |

### 3.4. Authoring the entry

Apply these steps in order; each is independently verifiable.

1. **Open** `CHANGELOG.md` and locate line 1 (`# Changelog`) and line 3 (`## v0.21.41 (2026-05-05)`).
2. **Insert** the new `## v0.22.0 (2026-05-08)` block between lines 2 and 3 (i.e. one blank line after `# Changelog`, then the new section, then a blank line, then the existing v0.21.41 section unchanged). Section skeleton:
   ```markdown
   ## v0.22.0 (2026-05-08)

   ### Breaking changes
   - <entry from KEEP -- Breaking changes table>
   - ...

   ### Removed
   - <entry from KEEP -- Removed features table>
   - ...

   ### Features
   - <entry from KEEP -- Features table>
   - ...

   ### Changed
   - <entry from KEEP -- Changed table>
   - ...

   ### Fixes
   - <entry from KEEP -- Fixes table>
   - ...
   ```
3. **Verify each entry against its source commit.** For every entry written, run `git show <hash>` (or `git log -1 <hash>`) and confirm the user-facing claim matches the diff. If the diff says less than the claim, narrow the claim. If the diff says more, broaden it -- or split into two entries. Do not let drafted text from this plan ship without that verification step.
4. **Sanity-grep for em dashes** in the new section: `grep -n "—" CHANGELOG.md` (the U+2014 character). Expected: zero matches in the new section. If any slipped in (e.g. from copy-paste), replace with `--`.
5. **Run `make format`** so Prettier normalises any trailing whitespace and line wrapping.
6. **Diff review.** `git diff CHANGELOG.md` should show **only** the new section inserted -- no edits to the v0.21.41 entry or earlier. If the diff touches earlier sections, undo those changes; this task does not retro-edit history.
7. **Read the new entry top to bottom out loud.** Ask: "Is each entry something a user running ark would notice or have to act on?" If the answer is no, delete that entry.

### 3.5. Commit

```bash
git add CHANGELOG.md PLAN.md
git commit -m "docs(changelog): add v0.22.0 entry"
git log --oneline -1   # verify
```

Commit subject style follows the existing pattern (`docs(changelog): add v0.21.41 entry`, `docs(changelog): add v0.18.0 entries`).

## 4. Testing strategy

This is a docs-only change; there is no test suite to extend. Verification is mechanical and visual.

- **`make format` succeeds.** Prettier covers Markdown; this catches trailing whitespace and inconsistent list indentation.
- **`make lint` is unaffected** but cheap -- run as belt-and-braces per the `make format && make lint` rule in `CLAUDE.md`.
- **`grep -n "—" CHANGELOG.md`** prints zero new matches in the v0.22.0 section. (Existing em dashes in older sections are untouched and are not in scope to fix.)
- **Diff review:** `git diff main -- CHANGELOG.md` should show insertion only, no deletion of any earlier entry's text.
- **Style audit (manual, the most important check):** for each `Fixed:` / `Changed:` / `Removed:` / `Renamed:` line, ask "could a user without source access infer what changed and whether it affects them?" If no -> rewrite or drop.
- **PR-link audit:** for each `(#NNN)` reference, run `gh pr view NNN --json state,title` and confirm the PR exists and matches the described change. Drop the reference if it doesn't, rather than ship an inaccurate citation.

## 5. Risk assessment

- **Blast radius:** documentation only. Zero runtime, build, schema, or test impact.
- **Wrong version number:** if the team has already chosen a version (e.g. v0.22.0 was reserved for something else, or the next bump is patch-level v0.21.42), my pick is wrong. The signal: a breaking rename (`ark daemon` -> `ark conductor`) and a removed env var are not patch-bump material under semver, so v0.22.0 is the right bucket *unless* the team semver-pins differently. See Open Questions.
- **Drafted entry text is wrong:** the drafts in section 3.3 are best-effort from commit messages. Several commits ("post-launch ops on AgentHandle", "runtime_config nesting") have ambiguity that the planner cannot fully resolve without reading the code -- the implementer **must** run `git show <hash>` and adjust before committing. The plan flags these inline.
- **Unlisted commits:** the planner classified the commits visible in `git log 9a3513da..HEAD` (130 commits). If a commit landed between planning and implementation (since 2026-05-08), it must be classified using the same rules. Run the `git log 9a3513da..HEAD` command at implementation time, not blindly trust this plan.
- **Missing user-impact judgement:** a commit listed in DROP could turn out to be user-facing on closer inspection (e.g. a "refactor" that quietly changed a default). Whenever the implementer feels uncertain, default to including with a tightly-scoped sentence, not to dropping silently.
- **Scope creep:** this task is **CHANGELOG only**. Tempting adjacent changes -- bumping `package.json` version, tagging a release, updating `docs/ROADMAP.md`, regenerating audit snapshots -- are out of scope and must not land in the same commit.

## 6. Open questions

1. **Version number.** Plan assumes **v0.22.0**. If the team prefers v0.21.42 (patch) or has already reserved v0.22.0, the implementer must adjust. Resolution: `git tag --list 'v0.*' | sort -V | tail -5` and check Slack `#ark-init` for any release-version pinning before committing.
2. **Date.** Plan uses **2026-05-08** (today). If the entry is meant to be backdated to a release tag's date, use that tag's date instead. Resolution: check whether a corresponding git tag is being pushed alongside this commit.
3. **`runtime_config` nesting -- breaking or not?** The drafted entry says "top-level placement still loads but is no longer canonical." This guess needs verification: read `git show 85f9794b -- 'packages/types/**'` to see whether the schema accepts both shapes or strictly the new one. If strict, the entry stays under `### Breaking changes`. If lenient, move it to `### Changed`.
4. **PR numbers.** Many commits referenced in this plan don't have an obvious PR number in the commit message subject; some are direct pushes. Where no PR exists, omit the `(#NNN)` reference rather than fabricate one.
5. **Should the v0.21.41 entry be amended?** Some of its claims (e.g. "EC2: write tunnel port to compute.config", "Action stage GITHUB_TOKEN from secrets store") were written ahead of the corresponding commits actually merging. The planner verified the wording is still accurate, but if implementer review finds a mismatch, the right move is a follow-up commit (not amending the v0.21.41 entry) -- this task does not edit history.
6. **`local-e2e-v13-quick-flow (#465)` (`4d71042a`).** Unclear from the subject whether this touched production code or only e2e infra. Resolution: `git show 4d71042a --stat`. If production paths changed, promote into an appropriate bucket; if pure e2e, leave under DROP.
