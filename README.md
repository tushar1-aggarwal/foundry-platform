# Ark

**The orchestration layer for AI coding agents.** Manage sessions, workflows, and compute so your agents ship code -- not just write it.

AI coding agents are powerful but ephemeral. They spin up, do work, and vanish -- leaving you to manage context, coordinate stages, track costs, and wire up infrastructure yourself. Ark handles all of that. Define a task, pick a workflow, and Ark drives your agents through a full SDLC pipeline -- intake, planning, audit, execution, verification, close, and retro -- across local machines, containers, cloud VMs, or Kubernetes pods. It works with any CLI coding tool: Claude Code, OpenAI Codex, Google Gemini CLI, or your own.

## Prerequisites

- macOS (arm64 or x64) or Linux (arm64 or x64)
- `git` (for worktree-based session isolation)
- At least one CLI coding agent ([Claude Code](https://docs.anthropic.com/en/docs/claude-cli), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli))

The install script downloads a self-contained tarball that bundles **ark** + **tmux** + **codegraph** (knowledge indexer) + **tensorzero-gateway** (optional LLM router backend). No package manager, no runtime installs required.

If you're installing from source via `make install`, you also need [Bun](https://bun.sh) and a system `tmux` because the source path doesn't vendor anything.

## Installation

```bash
# Self-contained tarball (recommended)
curl -fsSL https://ytarasova.github.io/ark/install.sh | bash

# Or from source
make install    # requires Bun + tmux pre-installed
```

Run `ark doctor` to verify your environment.

Prefer a native window? Install the [Ark Desktop app](packages/desktop/INSTALL.md)
(macOS, Windows, Linux). macOS users: there's an unsigned-build workaround
documented in the desktop install guide.

## Quick Start

```bash
# Create + dispatch a session (dispatch is automatic)
ark session start --repo . --summary "Add user auth"

# Pick a specific flow (default is `default`)
ark session start --repo . --summary "Add user auth" --flow autonomous-sdlc

# Launch the web dashboard (or desktop app)
ark web

# Fleet overview with cost charts
ark dashboard

# Search across all sessions and transcripts
ark search "authentication"
```

## Features

| Feature | Description | Docs |
|---------|-------------|------|
| **Sessions** | Full lifecycle management -- create, dispatch, stop, resume, fork, clone, export/import | [Guide](docs/guide.md#2-sessions) |
| **Multi-Runtime Support** | 6 runtimes (Claude Code, Claude Agent in-process SDK, Claude Max subscription, Codex, Gemini, Goose) with runtime/role separation -- any agent role on any LLM backend | [Guide](docs/guide.md#4-agents-and-runtimes) |
| **SDLC Flows** | DAG-based multi-stage pipelines with fan-out, auto-join, verification gates, and 13 specialized agents | [Guide](docs/guide.md#3-flows) |
| **Knowledge Graph** | Unified knowledge across codebase, sessions, memories, and learnings via ops-codegraph (33 languages via tree-sitter, native Rust engine) | [Guide](docs/guide.md#9-knowledge-graph) |
| **LLM Router** | OpenAI-compatible proxy with 3 routing policies, circuit breakers, and cost tracking. Injects `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` into executors at dispatch | [Guide](docs/guide.md#11-llm-router) |
| **TensorZero Gateway** | Optional Rust LLM gateway backing the Router. Starts as sidecar, native binary, or Docker container. Unified request/response handling across providers | [Guide](docs/guide.md#11-llm-router) |
| **Compute Templates** | Named compute presets in `~/.ark/config.yaml` under `compute_templates:`. CLI: `ark compute template list|show|create|delete`, `ark compute create --from-template <name>` | [Guide](docs/guide.md#8-compute-templates) |
| **Multi-Tenant Control Plane** | API key auth, tenant scoping on all entities, role-based access (admin/member/viewer), tenant integration policies (router_required, auto_index_required, tensorzero_enabled), DB-backed resource stores | [Guide](docs/guide.md#19-control-plane-hosted-mode) |
| **Auto-Index on Dispatch** | Local mode honors `knowledge.auto_index` config. Remote compute (arkd) ALWAYS indexes via `/codegraph/index` endpoint | [Guide](docs/guide.md#9-knowledge-graph) |
| **Runtime Billing Modes** | `api` (per-token pricing), `subscription` (e.g. Claude Max $200/mo, tokens recorded for rate limits), `free`. Polymorphic transcript parsers per runtime | [Guide](docs/guide.md#10-cost-tracking) |
| **Dashboard** | Fleet status overview with cost charts (Recharts), budget tracking, and recent activity | [CLI](docs/cli-reference.md#ark-dashboard) |
| **Web Dashboard** | Browser-based session management with SSE live updates, token auth, read-only mode | [Guide](docs/guide.md#15-dashboards-cli-web-desktop) |
| **Desktop App** | Electron wrapper around the web dashboard -- native menus, local-first | [Install](packages/desktop/INSTALL.md) |
| **Compute Providers** | Local, Docker, DevContainer, Firecracker, EC2 + arkd (base/docker/devcontainer/firecracker), K8s, K8s+Kata (self-hosted only) | [Guide](docs/guide.md#7-compute) |
| **Git Worktrees** | Automatic branch isolation per session, diff preview, merge + auto-PR in one command | [Guide](docs/guide.md#13-git-worktrees) |
| **Skills** | Reusable prompt fragments with three-tier resolution (builtin -> user -> repo) | [Guide](docs/guide.md#5-skills) |
| **Cost Tracking** | Automatic token usage collection, per-model pricing, budget limits, cost export | [Guide](docs/guide.md#10-cost-tracking) |
| **Search** | Full-text search across sessions, events, messages, and transcripts (FTS5) | [Guide](docs/guide.md#14-search) |
| **Auth & Multi-Tenancy** | API key auth, tenant scoping, role-based access (admin/member/viewer) | [Guide](docs/guide.md#12-auth-and-multi-tenancy) |
| **Remote Client Mode** | CLI/Web connect to a hosted Ark server via `--server`/`--token` | [Guide](docs/guide.md#18-remote-client-mode) |
| **Control Plane** | Worker registry, session scheduler, tenant policies, Redis SSE bus | [Guide](docs/guide.md#19-control-plane-hosted-mode) |
| **MCP Socket Pooling** | 85-90% memory reduction by sharing MCP server processes across agents | [Guide](docs/guide.md#17-mcp-integration) |
| **MCP Config Stubs** | Pre-configured integrations for Atlassian, GitHub, Linear, Figma, Pi-Sage | -- |
| **Messaging Bridges** | Telegram, Slack, Discord notifications and remote control | [Guide](docs/guide.md#22-messaging-bridges) |
| **Deployment** | Dockerfile, docker-compose, Helm chart with Kata/Firecracker support | [Guide](docs/guide.md#20-deployment) |

## Architecture

```
packages/
  cli/        Commander.js CLI entry point (ark command)
  core/       Sessions, store, flows, agents, channels, search (FTS5), costs,
              knowledge graph, auth, tenant policies, scheduler, SSE bus,
              TranscriptParserRegistry, PricingRegistry, UsageRecorder
    compute/    Self-hosted providers: local, docker, devcontainer, firecracker,
                ec2 (+arkd variants), k8s, k8s-kata
    knowledge/  Knowledge graph store, indexer (ops-codegraph), context builder, MCP tools, export/import
    services/   SessionService, ComputeService, HistoryService + orchestration
    repositories/  SQL CRUD (Session, Compute, ComputeTemplate, Event, Message, Todo)
    stores/     Resource stores (Flow, Skill, Agent, Runtime) -- three-tier file-backed,
                or DbResourceStore (resource_definitions table) in hosted mode
    runtimes/   Polymorphic transcript parsers (claude, codex, gemini)
    router/     TensorZero lifecycle manager
  arkd/       Universal agent daemon -- HTTP server on every compute target
  conductor/  Session scheduler + WebSocket dispatch (port 19400)
  router/     LLM Router -- OpenAI-compatible proxy with routing policies
  web/        Vite-based web dashboard (SSE live updates, Dashboard page)
  desktop/    Electron shell wrapping the web dashboard
  protocol/   ArkClient (typed JSON-RPC client)
  types/      Domain interfaces (Session, Compute, Event, Message, Tenant, etc.)
  e2e/        End-to-end tests (Playwright for web + desktop)

agents/       13 agent definitions (ticket-intake, spec-planner, plan-auditor,
              implementer, task-implementer, verifier, reviewer, documenter,
              closer, retro, planner, worker, goose-recipe-runner)
runtimes/     6 runtime definitions (claude-agent, claude-code, claude-max,
              codex, gemini, goose)
flows/definitions/   14 user-facing flows (default, quick, bare, autonomous,
              autonomous-sdlc, parallel, fan-out, pr-review, dag-parallel,
              islc, islc-quick, brainstorm, conditional, docs) plus internal
              fixtures (e2e-noop*, fan-out-execute, goose-recipe, islc-*-subtask,
              smoke-rohit-*)
skills/       7 builtin skills (code-review, plan-audit, sanity-gate,
              security-scan, self-review, spec-extraction, test-writing)
mcp-configs/  5 MCP config stubs (atlassian, figma, github, linear, pi-sage)
.infra/       Helm chart, k8s manifests, Temporal compose
Dockerfile, docker-compose.yaml at repo root
docs/         User documentation + GitHub Pages site
```

## Documentation

- **[User Guide](docs/guide.md)** -- comprehensive feature walkthrough
- **[CLI Reference](docs/cli-reference.md)** -- every command, option, and example
- **[Configuration](docs/configuration.md)** -- config files, themes, budgets
- **[CLAUDE.md](CLAUDE.md)** -- developer documentation (architecture, testing, gotchas)
- **[Contributing](CONTRIBUTING.md)** -- development setup, testing, and PR guidelines

## Development

```bash
make dev              # Hot-reload: API (:8420) + Vite HMR (:5173) + daemon
make test             # Run unit tests (parallel; excludes compute E2E + integration)
make test-file F=path # Run a single test file
make test-e2e         # Playwright E2E suite (web + desktop)
make web              # Launch web dashboard (production build)
make desktop          # Launch Electron desktop app
make build-desktop    # Build Electron app with bundled ark-native
make package-desktop  # Package Electron app (.dmg + .AppImage)
make lint             # ESLint + TypeScript (zero warnings allowed)
make format           # Prettier auto-fix
make clean            # Remove build artifacts
make uninstall        # Remove ark symlink
```

Tests use `bun:test`. Always run via `make test` -- it sets the right env (ephemeral arkDir, deterministic ports) and excludes compute-E2E suites that need real Docker/EC2.

## Deployment

```bash
# Docker
docker build -t ark .
docker-compose up -d          # Ark + Postgres + Redis

# Kubernetes (Helm)
helm install ark .infra/helm/ark -f .infra/helm/ark/values-production.yaml
```

The Helm chart deploys: control plane, worker pool, PostgreSQL, Redis, Ingress.

## Data

| Path | Purpose |
|------|---------|
| `~/.ark/ark.db` | SQLite database (WAL mode) -- local mode. Tenant-scoped tables: sessions, compute, compute_templates, compute_pools, events, messages, todos, groups, schedules, usage_records, resource_definitions, knowledge, knowledge_edges |
| `~/.ark/config.yaml` | User configuration (router, knowledge, tensorzero, compute_templates, auth) |
| `~/.ark/tracks/` | Launcher scripts per session |
| `~/.ark/worktrees/` | Git worktrees for isolated sessions |
| `~/.ark/skills/` | Global skill definitions |
| `~/.ark/recipes/` | Global recipe definitions |
| `~/.ark/profiles.json` | Profile definitions |
| `~/.ark/bridge.json` | Messaging bridge config (Telegram/Slack/Discord) |
| `.codegraph/graph.db` | ops-codegraph index (per-repo). Ingested into `knowledge`/`knowledge_edges` tables |
| `~/.claude/projects/` | Claude Code transcripts (JSONL) -- parsed by ClaudeTranscriptParser |
| `~/.codex/sessions/` | Codex transcripts (JSONL) -- parsed by CodexTranscriptParser (cwd-matched) |
| `~/.gemini/tmp/` | Gemini transcripts (JSONL) -- parsed by GeminiTranscriptParser (projectHash-matched) |

## License

MIT
