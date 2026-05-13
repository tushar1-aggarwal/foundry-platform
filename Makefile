# ── Ark Makefile ─────────────────────────────────────────────────────────────
#
# Local development, testing, building, and packaging.
#
# Quick reference:
#   make install       Install deps + symlink ark CLI
#   make claude-tfy    Claude Code -> TrueFoundry (direct; --continue + skip-permissions on by default)
#   make pi-tfy        pi.dev CLI -> TrueFoundry (uses ~/.pi/agent/models.json's `truefoundry` provider)
#   make dev           Hot-reload CLI + Web UI (two processes)
#   make test          Run all unit tests (sequential)
#   make test-e2e      Run Playwright E2E tests against Web UI
#   make build         Build native macOS binary + Electron app
#   make package       Package everything for distribution

.PHONY: help install dev dev-daemon dev-arkd dev-web dev-temporal dev-temporal-down dev-temporal-worker dev-docker dev-control-plane dev-control-plane-down dev-control-plane-bootstrap claude-tfy pi-tfy web desktop \
        test test-file test-e2e test-e2e-fast test-e2e-web test-e2e-web-dev test-install test-watch test-e2e-local-bespoke test-e2e-control-plane test-e2e-control-plane-up test-e2e-control-plane-down test-e2e-t6-docker test-laptop-real-llm lint lint-fix \
        format format-check \
        docs-cli \
        build build-cli build-web build-desktop \
        package package-cli package-desktop \
        spike-temporal-bun \
        vendor-tmux vendor-tensorzero vendor-codegraph \
        clean uninstall \
        agent-sdk-secrets smoke-agent-sdk smoke-agent-sdk-clean

BUN := bun
ARK_BIN := /usr/local/bin/ark

# ── T6 e2e: host paths exported to docker-compose.e2e.yaml ───────────────────
# Universal: derived from the operator's `$(CURDIR)` (repo root the Makefile
# was invoked from) and `$(HOME)`. No hardcoded user paths. Override on the
# command line if your layout differs (e.g. `make ... ARK_HOST_ARKDIR=/foo`).
export ARK_HOST_REPO_ROOT ?= $(CURDIR)
export ARK_HOST_ARKDIR    ?= $(CURDIR)/.tmp/t6-arkdir
export ARK_HOST_HOME      ?= $(HOME)
# Bedrock allowlist ids are pi-agentic/<slug> (two /-segments). Use that literal string for make claude-tfy.
TRUEFOUNDRY_ANTHROPIC_MODEL_DEFAULT := pi-agentic/global.anthropic.claude-opus-4-6-v1
# make claude-tfy passes --dangerously-skip-permissions unless CLAUDE_SKIP_PERMISSIONS=0 (unsafe; dev/sandbox only).
CLAUDE_SKIP_PERMISSIONS ?= 1
CLAUDE_DANGEROUSLY_SKIP_FLAGS := $(if $(filter 0,$(CLAUDE_SKIP_PERMISSIONS)),,--dangerously-skip-permissions)
# Resume latest session in this directory unless CLAUDE_CONTINUE=0.
CLAUDE_CONTINUE ?= 1
CLAUDE_CONTINUE_FLAGS := $(if $(filter 0,$(CLAUDE_CONTINUE)),,--continue)

help: ## Show available commands
	@echo ""
	@echo "  \033[1mDevelopment\033[0m"
	@grep -E '^(install|dev|dev-daemon|dev-arkd|dev-web|dev-docker|dev-temporal|dev-temporal-down|dev-temporal-worker|dev-control-plane|dev-control-plane-down|dev-control-plane-bootstrap|claude-tfy|pi-tfy|web|desktop):' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  \033[1mTesting\033[0m"
	@grep -E '^(test|test-file|test-e2e|test-install|test-watch|lint|format):' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  \033[1mBuilding & Packaging\033[0m"
	@grep -E '^(build|build-cli|build-web|build-desktop|package|package-cli|package-desktop):' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  \033[1mOther\033[0m"
	@grep -E '^(clean|uninstall|lint):' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""

# ── Development ──────────────────────────────────────────────────────────────

install: ## Install deps and symlink `ark` to PATH
	@command -v bun >/dev/null 2>&1 || { echo "Bun not found. Install: curl -fsSL https://bun.sh/install | bash"; exit 1; }
	$(BUN) install
	@mkdir -p $(HOME)/.ark/bin
	@echo "Linking ark -> $(HOME)/.ark/bin/ark"
	@ln -sf "$(CURDIR)/ark" $(HOME)/.ark/bin/ark
	@ln -sf "$(CURDIR)/ark" $(ARK_BIN) 2>/dev/null || true
	@echo "Done."

dev: ## Hot-reload: API + Vite HMR + daemon
	@$(BUN) install --silent
	@# Start daemon if not already running
	@curl -sf http://localhost:19100/health > /dev/null 2>&1 || \
		(echo "Starting daemon..." && ./ark server daemon start --detach 2>/dev/null && sleep 1) || true
	@echo "\033[1mArk dev mode\033[0m"
	@echo "  API:  http://localhost:8420  (bun --watch, auto-restarts on changes)"
	@echo "  Web:  http://localhost:5173  (Vite HMR, proxies /api to :8420)"
	@echo "  CLI:  ./ark <command>        (runs from source, no build)"
	@echo ""
	@trap 'kill 0' EXIT; \
	  $(BUN) --watch packages/cli/index.ts web --port 8420 --api-only 2>&1 | sed 's/^/[api] /' & \
	  sleep 1 && cd packages/web && npx vite --port 5173 2>&1 | sed 's/^/[web] /' & \
	  wait

dev-daemon: ## Hot-reload: server daemon (conductor :19100 + arkd :19300 + WS :19400)
	@echo "\033[1mArk server daemon (hot-reload)\033[0m"
	@echo "  WebSocket:  ws://localhost:19400"
	@echo "  Conductor:  http://localhost:19100"
	@echo "  ArkD:       http://localhost:19300"
	@echo ""
	$(BUN) --watch packages/cli/index.ts server daemon start

dev-arkd: ## Hot-reload: arkd agent daemon (port from .env.control-plane = :19301)
	@test -f .env.control-plane || { echo ".env.control-plane missing"; exit 1; }
	@set -a && . ./.env.control-plane && set +a && \
	  echo "\033[1mArkD agent daemon (hot-reload)\033[0m" && \
	  echo "  ArkD:  http://localhost:$$ARK_ARKD_PORT" && \
	  echo "" && \
	  $(BUN) --watch packages/cli/index.ts arkd

dev-web: ## Hot-reload: API server (:8420) + Vite frontend (:5173)
	@echo "\033[1mArk Web (hot-reload)\033[0m"
	@echo "  API:  http://localhost:8420"
	@echo "  Web:  http://localhost:5173"
	@echo ""
	@trap 'kill 0' EXIT; \
	  $(BUN) --watch packages/cli/index.ts web --port 8420 --api-only 2>&1 | sed 's/^/[api] /' & \
	  sleep 1 && cd packages/web && npx vite --port 5173 2>&1 | sed 's/^/[web] /' & \
	  wait

dev-temporal: ## Start local Temporal cluster (server :7233 + UI :8088) for Phase 0/1
	@command -v docker >/dev/null 2>&1 || { echo "Docker required. Install Docker Desktop."; exit 1; }
	@echo "\033[1mStarting Ark local Temporal cluster...\033[0m"
	# `--wait` fails when the run-once `temporal-admin` container exits 0
	# (which it is supposed to do after registering the namespace). Run
	# without --wait and rely on the per-service healthchecks plus the
	# follow-up health probe in dev-control-plane.
	$(DOCKER_COMPOSE) -f .infra/docker-compose.temporal.yaml -p ark-temporal up -d
	@echo ""
	@echo "  Temporal gRPC:   localhost:7233     (ARK_TEMPORAL_ADDRESS=localhost:7233)"
	@echo "  Temporal UI:     http://localhost:8088"
	@echo "  Namespace:       ark-dev"
	@echo "  Postgres:        localhost:15432   (isolated from ark dev db)"
	@echo ""
	@echo "  See docs/temporal-local-dev.md for next steps."

dev-temporal-down: ## Stop and remove the local Temporal cluster + its data volume
	$(DOCKER_COMPOSE) -f .infra/docker-compose.temporal.yaml -p ark-temporal down -v
	@echo "Ark local Temporal cluster stopped."

# Pick whichever docker compose CLI is on PATH. Modern installs ship the
# plugin (`docker compose`); older engines + the standalone v2 release
# ship as `docker-compose`. Some laptop setups have only one of the two.
DOCKER_COMPOSE := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")

dev-docker: ## Sub-target: Postgres :15433 + Redis :6379 containers (factored out of dev-control-plane)
	@command -v docker >/dev/null 2>&1 || { echo "Docker required. Install Docker Desktop."; exit 1; }
	@echo "\033[1mStarting Ark dev docker (Postgres + Redis)...\033[0m"
	# Scope to postgres+redis only. The compose file also defines `temporal-worker`,
	# but that service depends on the Temporal server (separate `ark-temporal` project)
	# being up at host.docker.internal:7233. `dev-control-plane` brings the worker up
	# explicitly after `dev-temporal`; running it here would fail `--wait`.
	$(DOCKER_COMPOSE) -f .infra/docker-compose.dev.yaml -p ark-dev up -d --wait postgres redis
	@echo ""
	@echo "  Postgres:  postgres://ark:ark@localhost:15433/ark"
	@echo "  Redis:     redis://localhost:6379"

dev-temporal-worker: ## Sub-target: Temporal worker on host (Node + tsx; Bun lacks v8.promiseHooks)
	@command -v node >/dev/null || { echo "Node required for Temporal worker"; exit 1; }
	@command -v tsx >/dev/null || { echo "Installing tsx globally..."; npm install -g tsx; }
	@test -f .env.control-plane || { echo ".env.control-plane missing"; exit 1; }
	@set -a && . ./.env.control-plane && set +a && \
	  echo "\033[1mArk Temporal worker (host, Node + tsx)\033[0m" && \
	  echo "  Temporal:  $$ARK_TEMPORAL_SERVER_URL  ns=$$ARK_TEMPORAL_NAMESPACE" && \
	  echo "  arkd:      $$ARK_ARKD_URL" && \
	  echo "  conductor: http://localhost:$$ARK_WEB_PORT" && \
	  echo "" && \
	  exec tsx packages/core/temporal/worker.ts

dev-control-plane: dev-temporal dev-docker ## Boot full laptop dev stack -- docker + arkd + temporal worker + ark server
	@test -f .env.control-plane || { echo ".env.control-plane missing"; exit 1; }
	@# Ensure host-side bun deps are present. Without this, arkd/server/daemon
	@# crash immediately with `Cannot find module '@temporalio/activity'` on a
	@# fresh checkout (or after a clean). Matches the `dev` target's pattern.
	@$(BUN) install --silent
	@# Pre-build the web bundle. The server has a lazy auto-build at
	@# `packages/core/hosted/web.ts:195` with a 30s timeout that silently
	@# swallows errors; Vite cold builds routinely exceed that on a fresh
	@# checkout, leaving the UI as 404s. Build explicitly so the dist is
	@# ready when `server start` initializes its static handler.
	@$(MAKE) build-web --no-print-directory
	@echo ""
	@echo "\033[1mArk dev stack -- full laptop\033[0m"
	@set -a && . ./.env.control-plane && set +a && \
	  echo "  ark server:        http://localhost:$$ARK_WEB_PORT" && \
	  echo "  arkd:              http://localhost:$$ARK_ARKD_PORT" && \
	  echo "  Temporal UI:       http://localhost:8088" && \
	  echo "  Temporal gRPC:     $$ARK_TEMPORAL_SERVER_URL  ns=$$ARK_TEMPORAL_NAMESPACE" && \
	  echo "  Temporal worker:   docker (image ark-temporal-worker:dev)" && \
	  echo "  Postgres:          localhost:15433" && \
	  echo "  Redis:             localhost:6379" && \
	  echo "" && \
	  echo "  One-time after first boot:  make dev-control-plane-bootstrap" && \
	  echo "  Stop everything:            make dev-control-plane-down" && \
	  echo ""
	@$(DOCKER_COMPOSE) -f .infra/docker-compose.dev.yaml -p ark-dev up -d temporal-worker
	@set -a ; . ./.env.control-plane ; set +a ; \
	  trap 'kill 0' EXIT ; \
	  $(BUN) --watch packages/cli/index.ts arkd 2>&1 | sed 's/^/[arkd]    /' & \
	  sleep 1 && $(BUN) packages/cli/index.ts server start --hosted --port $$ARK_WEB_PORT 2>&1 | sed 's/^/[server]  /' & \
	  sleep 2 && $(BUN) packages/cli/index.ts server daemon start --port $$ARK_CONDUCTOR_PORT 2>&1 | sed 's/^/[daemon]  /' & \
	  wait

dev-control-plane-down: ## Stop everything: containers + any host processes still listening
	@$(DOCKER_COMPOSE) -f .infra/docker-compose.dev.yaml      -p ark-dev      down 2>&1 | sed 's/^/[ark-dev]    /' || true
	@$(DOCKER_COMPOSE) -f .infra/docker-compose.temporal.yaml -p ark-temporal down 2>&1 | sed 's/^/[temporal]   /' || true
	@set -a && . ./.env.control-plane && set +a && \
	  for port in $$ARK_WEB_PORT $$ARK_CONDUCTOR_PORT $$ARK_ARKD_PORT; do \
	    pid=$$(lsof -nP -iTCP:$$port -sTCP:LISTEN -t 2>/dev/null | head -1); \
	    if [ -n "$$pid" ]; then echo "killing PID $$pid on :$$port"; kill $$pid 2>/dev/null || true; fi; \
	  done

dev-control-plane-bootstrap: ## One-time: register `compute/create local` so dispatch can run
	@test -f .env.control-plane || { echo ".env.control-plane missing"; exit 1; }
	@set -a && . ./.env.control-plane && set +a && \
	  echo "Registering compute=local against ark server on :$$ARK_WEB_PORT..." && \
	  curl -sf -X POST http://localhost:$$ARK_WEB_PORT/api/rpc \
	    -H 'Content-Type: application/json' \
	    -d '{"jsonrpc":"2.0","id":"1","method":"compute/create","params":{"name":"local","compute":"local","isolation":"direct"}}' \
	  | (jq . 2>/dev/null || cat) ; \
	  echo

# Bootstrap the FIRST admin API key on a deployment with auth required.
# `admin/apikey/create` is gated by requireAdmin -- without an existing
# admin key (or a Google-logged-in admin), there's no way to mint one
# (#550). This target sidesteps the gate by booting a one-shot daemon
# in local mode (requireToken=false), minting the key, then exiting.
# The minted key persists across daemon restarts.
#
# Usage: make bootstrap-key NAME=ops-bootstrap [TENANT=default] [ROLE=admin]
# Save the printed plaintext immediately -- it cannot be retrieved later.
bootstrap-key: ## Mint the first admin API key (auth-required deployments)
	@test -n "$(NAME)" || { echo 'Usage: make bootstrap-key NAME=ops-bootstrap [TENANT=default] [ROLE=admin]'; exit 1; }
	@tenant="$${TENANT:-default}"; \
	  role="$${ROLE:-admin}"; \
	  if curl -sf http://localhost:19400/health >/dev/null 2>&1; then \
	    echo "A daemon is already running on :19400 -- stop it first ('ark conductor stop')."; \
	    exit 1; \
	  fi; \
	  echo "Booting one-shot daemon in local mode to mint key..."; \
	  unset ARK_AUTH_REQUIRE_TOKEN; \
	  ./ark server daemon start --detach >/dev/null 2>&1 || true; \
	  for i in 1 2 3 4 5 6 7 8 9 10; do \
	    sleep 1; \
	    if curl -sf http://localhost:19400/health >/dev/null 2>&1; then break; fi; \
	  done; \
	  ./ark auth create-key --name "$(NAME)" --tenant "$$tenant" --role "$$role"; \
	  echo ""; \
	  echo "Restart the daemon with ARK_AUTH_REQUIRE_TOKEN=true to enable auth."; \
	  echo "Key is persisted in the database; it survives the restart."; \
	  ./ark server daemon stop >/dev/null 2>&1 || true

spike-temporal-bun: ## Run the Phase 0 Bun / Temporal worker compat spike
	@./scripts/spike-temporal-bun.sh

# TrueFoundry: https://truefoundry.com/docs/ai-gateway/claude-code (ANTHROPIC_BASE_URL + Bearer in ANTHROPIC_CUSTOM_HEADERS).
# Claude Code gateway requirements: https://code.claude.com/docs/en/llm-gateway (Messages /v1/messages, forward anthropic-* headers).
claude-tfy: ## Claude Code -> TrueFoundry (direct; --continue unless CLAUDE_CONTINUE=0)
	@command -v claude >/dev/null 2>&1 || { echo "Claude Code not found. Install: https://docs.anthropic.com/en/docs/claude-code"; exit 1; }
	cd "$(CURDIR)" && \
	  if [ -f .env.dev ]; then set -a && . ./.env.dev && set +a; fi && \
	  test -n "$$TRUEFOUNDRY_API_KEY" || { echo "Set TRUEFOUNDRY_API_KEY in .env.dev"; exit 1; } && \
	  tfy_anth_base="$$TRUEFOUNDRY_ANTHROPIC_BASE_URL"; \
	  if [ -z "$$tfy_anth_base" ]; then tfy_anth_base="$$TRUEFOUNDRY_API_BASE"; fi; \
	  if [ -z "$$tfy_anth_base" ]; then echo "Set TRUEFOUNDRY_ANTHROPIC_BASE_URL (preferred) or TRUEFOUNDRY_API_BASE in .env.dev"; exit 1; fi; \
	  unset ANTHROPIC_AUTH_TOKEN 2>/dev/null || true; \
	  export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 && \
	  export ANTHROPIC_BASE_URL="$$tfy_anth_base" && \
	  export ANTHROPIC_API_KEY=dummy && \
	  export ANTHROPIC_CUSTOM_HEADERS="Authorization: Bearer $$TRUEFOUNDRY_API_KEY" && \
	  if [ -z "$(strip $(ARGS))" ]; then \
	    tfy_m="$$TRUEFOUNDRY_ANTHROPIC_MODEL"; \
	    if [ -z "$$tfy_m" ]; then tfy_m="$(TRUEFOUNDRY_ANTHROPIC_MODEL_DEFAULT)"; fi; \
	    export ANTHROPIC_MODEL="$$tfy_m" && \
	    exec claude $(CLAUDE_DANGEROUSLY_SKIP_FLAGS) $(CLAUDE_CONTINUE_FLAGS); \
	  else \
	    exec claude $(CLAUDE_DANGEROUSLY_SKIP_FLAGS) $(CLAUDE_CONTINUE_FLAGS) $(ARGS); \
	  fi

# pi.dev (https://pi.dev) reads its provider table from ~/.pi/agent/models.json.
# This target assumes you've already populated that file with a `truefoundry`
# provider whose api=anthropic-messages and apiKey=<TFY JWT>. The model id
# defaults to TRUEFOUNDRY_ANTHROPIC_MODEL_DEFAULT (same Bedrock allowlist slug
# claude-tfy uses); override per-invocation with `make pi-tfy PI_MODEL=<id>`.
# Pass extra pi args via ARGS, e.g. `make pi-tfy ARGS="-p 'one-shot prompt'"`.
pi-tfy: ## pi.dev CLI -> TrueFoundry (reads ~/.pi/agent/models.json)
	@command -v pi >/dev/null 2>&1 || { echo "pi not found. Install: https://pi.dev"; exit 1; }
	@test -f $$HOME/.pi/agent/models.json || { \
	  echo "Missing ~/.pi/agent/models.json -- configure providers first."; \
	  echo "Schema: https://pi.dev/docs/latest/models"; \
	  exit 1; }
	@pi_m="$${PI_MODEL:-$(TRUEFOUNDRY_ANTHROPIC_MODEL_DEFAULT)}"; \
	  exec pi --provider truefoundry --model "$$pi_m" $(ARGS)

self: ## Dispatch full SDLC (plan->implement->review->PR) against THIS repo
	@test -n "$(TASK)" || (echo 'Usage: make self TASK="<description>"'; exit 1)
	./ark session start --recipe self-dogfood --summary "$(TASK)" --dispatch

self-quick: ## Dispatch single-agent quick fix against THIS repo
	@test -n "$(TASK)" || (echo 'Usage: make self-quick TASK="<description>"'; exit 1)
	./ark session start --recipe self-quick --summary "$(TASK)" --dispatch

web: ## Launch the web dashboard (production build)
	@$(MAKE) build-web --no-print-directory
	./ark web

desktop: build-web ## Launch the Electron desktop app
	@cd packages/desktop && npm install --silent 2>/dev/null && npx electron .

# ── Testing ──────────────────────────────────────────────────────────────────

test: build-web ## Run unit tests (parallel; excludes compute E2E and integration suites)
	$(BUN) test --concurrency 4 \
	  $$(find packages -name '*.test.ts' -o -name '*.test.tsx' | grep -v e2e | grep -v local-arkd | grep -v local-provider | grep -v /dist/ | sort)

test-file: ## Run a single test: make test-file F=packages/core/__tests__/foo.test.ts
	$(BUN) test $(F) --concurrency 4

test-e2e: test-web-e2e ## Run all end-to-end tests (web Playwright)

test-e2e-local-bespoke: ## Run local-mode docs-flow e2e (no Docker, SQLite, bespoke dispatch)
	@command -v tmux >/dev/null 2>&1 || { echo "tmux required (brew install tmux / apt-get install tmux)."; exit 1; }
	@echo "\033[1mRunning local bespoke docs-flow e2e...\033[0m"
	@$(BUN) test --bail e2e/local-bespoke.test.ts

# Control-plane e2e -- the test-side counterpart of `dev-control-plane`.
#
# `dev-control-plane` brings up the full hosted-mode stack (Postgres + Redis + Temporal
# + worker + arkd + ark server) and runs the dev processes against it; the
# stack stays up across `Ctrl+C` so the developer can iterate.
# `test-e2e-control-plane` mirrors that shape for the test side: bring up an
# isolated stack (shifted +1 from dev ports so both can coexist), run every
# docker-stack e2e test file in `e2e/`, and leave the stack up for re-runs.
# Tear down explicitly via `test-e2e-control-plane-down`.
#
# Iteration loop:
#   make test-e2e-control-plane        # boots stack (idempotent) + runs tests
#   make test-e2e-control-plane        # re-uses stack, much faster
#   make test-e2e-control-plane-down   # stop + drop volumes when done
#
# Test files run sequentially against the same stack via ARK_E2E_STACK_RUNNING=1
# so their internal compose lifecycle is a no-op.
#
# CI must have docker + tmux on PATH. The test spawns the real `ark server
# start --hosted` binary and exercises the dispatch chain via /api/rpc --
# never imports AppContext directly.
test-e2e-control-plane: test-e2e-control-plane-up ## Run all docker-stack e2e tests (boots stack, leaves it up)
	@command -v tmux >/dev/null 2>&1 || { echo "tmux required for control-plane e2e (brew install tmux / apt-get install tmux)."; exit 1; }
	@# Migration runner uses session-scoped `pg_advisory_lock` which is
	@# released on connection close. The hosted ark server has no SIGTERM
	@# handler that drains the postgres pool, so a SIGKILL'd test run leaves
	@# orphan idle connections holding the migration lock. Subsequent boots
	@# block forever on `pg_advisory_lock(hashtext('ark_migrations'))`. Until
	@# the server learns graceful shutdown, terminate every non-self backend
	@# in the ark DB before each test run. Safe because the test owns the
	@# whole stack lifecycle while this target is executing.
	@$(DOCKER_COMPOSE) -f .infra/docker-compose.e2e.yaml -p ark-e2e exec -T postgres \
	  psql -U ark -d ark -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ark' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
	@echo "\033[1mRunning Temporal hosted docs-flow e2e...\033[0m"
	@ARK_E2E_STACK_RUNNING=1 $(BUN) test --bail e2e/temporal-control-plane.test.ts

test-e2e-control-plane-up: ## Bring up the e2e Docker stack (Postgres :15434 + Redis :6380 + Temporal :7234)
	@command -v docker >/dev/null 2>&1 || { echo "Docker required for control-plane e2e."; exit 1; }
	@echo "\033[1mBringing up e2e Docker stack...\033[0m"
	@mkdir -p "$(ARK_HOST_ARKDIR)"
	@# Build the worker image only when it doesn't exist locally. Once cached,
	@# subsequent runs use the cached image -- crucial on networks that MITM
	@# the npm/docker registries (Zscaler etc) where a forced rebuild would
	@# hang on `bun install`. To force a rebuild, run:
	@#   docker compose -f .infra/docker-compose.e2e.yaml -p ark-e2e build temporal-worker
	@if ! docker image inspect ark-temporal-worker:e2e >/dev/null 2>&1; then \
	  echo "  building temporal-worker image (first run)..."; \
	  $(DOCKER_COMPOSE) -f .infra/docker-compose.e2e.yaml -p ark-e2e build temporal-worker; \
	fi
	@$(DOCKER_COMPOSE) -f .infra/docker-compose.e2e.yaml -p ark-e2e up -d --wait

test-e2e-control-plane-down: ## Tear down the e2e Docker stack and volumes
	$(DOCKER_COMPOSE) -f .infra/docker-compose.e2e.yaml -p ark-e2e down -v

# ── T6 end-to-end (real claude in docker sidecar) ─────────────────────────────
#
# Brings up the e2e Docker stack + a host-side temporal worker, runs the
# laptop-docs-real-llm test against `compute=local + isolation=docker`.
# claude runs inside a per-session sidecar container (`ark-rt-local`)
# spawned by DockerIsolation; the sidecar receives the host's Claude OAuth
# token via a Keychain mirror (T6 pre-flight writes it to
# ~/.claude/.credentials.json on every run).
#
# Worker location: host process, not the compose `temporal-worker` service.
# Reason: when Zscaler intercepts TLS, the compose worker image can't be
# rebuilt with the `docker` CLI -- binary fetches from download.docker.com
# get MITM-mangled. Host already has docker working, so the host-worker
# path is unblocked. Once Docker Desktop's daemon trusts the Zscaler CA,
# revert this to worker-in-compose.
#
# Pre-reqs the operator owns:
#   - macOS Keychain: signed in to Claude Code (`claude` once, complete OAuth)
#   - Bitbucket SSH auth via ~/.ssh (mounted into sidecar) OR BITBUCKET_TOKEN
#     env var (passed through to a tenant secret; skips ~/.ssh mount)
#
# Stack layout:
#   postgres:15434  redis:6380  temporal:7234  temporal-worker  (compose)
#   ark-rt-local                                                (per-session)
#   ark server :8422   (host process, started by this target)
#   tsx temporal/worker.ts (host process, points at e2e Temporal :7234)
#
# Cleanup: `make test-e2e-control-plane-down` tears the docker stack down.
test-laptop-real-llm: ## Run the laptop real-LLM docs flow (T6 direct mode) against the running dev-control-plane stack
	@command -v tmux >/dev/null 2>&1 || { echo "tmux required."; exit 1; }
	@curl -sf http://localhost:8421/api/health >/dev/null 2>&1 || { \
	  echo ""; \
	  echo "  Dev stack not reachable on :8421."; \
	  echo "  Boot it first in another terminal:  make dev-control-plane"; \
	  echo "  One-time after first boot:          make dev-control-plane-bootstrap"; \
	  echo ""; \
	  exit 1; \
	}
	@echo "\033[1mRunning laptop real-LLM docs flow (direct mode, real Claude, real Bitbucket)...\033[0m"
	@# Default repo URL to the SSH form so the test's git ls-remote preflight uses
	@# the user's SSH key instead of prompting for HTTPS credentials. Operators
	@# with HTTPS-only auth can override on the command line:
	@#   T6_REPO_URL=https://... make test-laptop-real-llm
	@ARK_REAL_LLM_E2E=1 \
	  T6_REPO_URL=$${T6_REPO_URL:-git@bitbucket.org:paytmteam/foundry-test-repo.git} \
	  $(BUN) test e2e/laptop-docs-real-llm.test.ts --timeout 720000

test-e2e-t6-docker: test-e2e-control-plane-up ## Run T6 (real claude in docker sidecar) end-to-end
	@command -v tmux >/dev/null 2>&1 || { echo "tmux required (host side, for ark server)."; exit 1; }
	@# Migration lock cleanup (same trick the bespoke target uses) -- prior
	@# crashed runs can leave idle backends holding the advisory lock.
	@$(DOCKER_COMPOSE) -f .infra/docker-compose.e2e.yaml -p ark-e2e exec -T postgres \
	  psql -U ark -d ark -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ark' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
	@# Two workers on the same task queue race for dispatches; stop the
	@# compose worker so the host worker we spawn next owns every task.
	@docker stop ark-e2e-temporal-worker-1 >/dev/null 2>&1 || true
	@# Clean up any orphaned sidecar from a prior crashed run. New session
	@# will create a fresh one.
	@docker rm -f ark-rt-local >/dev/null 2>&1 || true
	@# Clean stale worktrees -- `cloneRemoteRepoIfNeeded` refuses to clone
	@# into a non-empty directory. Each test run gets a fresh session id but
	@# leftover dirs from interrupted prior runs collide with `mkdir + git
	@# clone` if ARK_HOST_ARKDIR is reused.
	@rm -rf "$(ARK_HOST_ARKDIR)/worktrees"
	@echo "\033[1mStarting host ark server :8422 against e2e stack...\033[0m"
	@lsof -ti :8422 -i :19302 2>/dev/null | xargs -r kill -9 2>/dev/null || true
	@sleep 1
	@set -a; . ./.env.e2e; set +a; \
	  ARK_DIR=$(ARK_HOST_ARKDIR) ARK_TEMPORAL_ORCHESTRATION=true ARK_CONDUCTOR_HOSTNAME=0.0.0.0 \
	    $(BUN) packages/cli/index.ts server start --hosted --port 8422 > $(ARK_HOST_ARKDIR)/server.log 2>&1 & \
	  echo $$! > $(ARK_HOST_ARKDIR)/server.pid
	@# Wait for /api/health (max 30s).
	@for i in $$(seq 1 60); do \
	  if curl -sf http://localhost:8422/api/health >/dev/null 2>&1; then echo "  ark server up"; break; fi; \
	  sleep 0.5; \
	done
	@# Start host-side temporal worker pointing at e2e Temporal :7234.
	@# This is the dispatcher that spawns DockerIsolation sidecars via the
	@# host's docker daemon. Killed alongside the ark server in the trap.
	@echo "\033[1mStarting host temporal worker against e2e :7234...\033[0m"
	@ARK_DIR=$(ARK_HOST_ARKDIR) \
	  DATABASE_URL="postgres://ark:ark@localhost:15434/ark?sslmode=disable" \
	  ARK_TEMPORAL_SERVER_URL=localhost:7234 ARK_TEMPORAL_NAMESPACE=default \
	  ARK_PROFILE=control-plane ARK_BLOB_BACKEND=local \
	  ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE=1 ARK_SECRETS_BACKEND=file \
	  ARK_AUTH_REQUIRE_TOKEN=false ARK_DEFAULT_TENANT=default \
	  ARK_TEMPORAL_WORKER=true ARK_TEMPORAL_ORCHESTRATION=true \
	  ARK_ENABLE_TEST_ACTIONS=1 \
	  ARK_LOG_LEVEL=info ARK_CONDUCTOR_URL=http://localhost:8422 \
	  ARK_ARKD_PORT=19302 ARK_WEB_PORT=8422 ARK_CONDUCTOR_PORT=19102 \
	  tsx packages/core/temporal/worker.ts > $(ARK_HOST_ARKDIR)/worker.log 2>&1 & \
	  echo $$! > $(ARK_HOST_ARKDIR)/worker.pid
	@# Wait for worker to register.
	@for i in $$(seq 1 60); do \
	  if grep -q "Worker state changed" "$(ARK_HOST_ARKDIR)/worker.log" 2>/dev/null; then echo "  host worker up"; break; fi; \
	  sleep 0.5; \
	done
	@# Seed compute=local + isolation=docker (idempotent: create or update).
	@curl -sf -X POST http://localhost:8422/api/rpc -H 'Content-Type: application/json' \
	  -d '{"jsonrpc":"2.0","id":"1","method":"compute/create","params":{"name":"local","compute":"local","isolation":"docker"}}' >/dev/null 2>&1 || true
	@$(DOCKER_COMPOSE) -f .infra/docker-compose.e2e.yaml -p ark-e2e exec -T postgres \
	  psql -U ark -d ark -c "UPDATE compute SET isolation_kind='docker', updated_at=NOW() WHERE name='local' AND tenant_id='default';" >/dev/null 2>&1
	@# Seed empty ANTHROPIC_* tenant secrets. StageSecretResolver requires
	@# these names to exist (even when empty) -- without them dispatch fails
	@# with "Missing secrets for tenant 'default'". Empty values let claude
	@# fall through to the Keychain-mirrored OAuth in ~/.claude/credentials.json
	@# inside the sidecar. Operators with a real key in env can override.
	@for n in ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS; do \
	  v=$$(eval echo "\$$$$n"); \
	  curl -sf -X POST http://localhost:8422/api/rpc -H 'Content-Type: application/json' \
	    -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"secret/set\",\"params\":{\"name\":\"$$n\",\"value\":\"$$v\",\"type\":\"env-var\"}}" >/dev/null 2>&1; \
	done
	@echo "  ANTHROPIC_* secrets seeded (empty unless overridden in env)"
	@# Seed BITBUCKET_TOKEN from operator env if provided. When set, the
	@# sidecar drops the ~/.ssh bind-mount and pushes via HTTPS-token; when
	@# unset, T6 falls back to the existing SSH key mount (still works,
	@# just less prod-aligned). Token format: Bitbucket Cloud HTTP access
	@# token or app password with `repository:write` scope.
	@if [ -n "$$BITBUCKET_TOKEN" ]; then \
	  curl -sf -X POST http://localhost:8422/api/rpc -H 'Content-Type: application/json' \
	    -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"secret/set\",\"params\":{\"name\":\"BITBUCKET_TOKEN\",\"value\":\"$$BITBUCKET_TOKEN\",\"type\":\"env-var\"}}" >/dev/null 2>&1 \
	    && echo "  BITBUCKET_TOKEN seeded -> sidecar will skip ~/.ssh mount"; \
	else \
	  echo "  BITBUCKET_TOKEN not in env -- sidecar will use host ~/.ssh mount"; \
	fi
	@# Run T6. Trap kills both host processes (ark server + temporal worker)
	@# even if bun test exits non-zero. Sidecar container left for inspection;
	@# `make test-e2e-control-plane-down` removes it via stack teardown.
	@trap 'kill -TERM $$(cat $(ARK_HOST_ARKDIR)/server.pid 2>/dev/null) $$(cat $(ARK_HOST_ARKDIR)/worker.pid 2>/dev/null) 2>/dev/null || true' EXIT INT TERM; \
	  ARK_REAL_LLM_E2E=1 T6_ISOLATION=docker \
	  ARK_BITBUCKET_TOKEN_AVAILABLE=$$([ -n "$$BITBUCKET_TOKEN" ] && echo 1 || echo 0) \
	  T6_WEB_URL=http://localhost:8422 T6_ARKD_URL=http://localhost:19302 T6_TEMPORAL_PORT=7234 \
	  T6_REPO_URL=$${T6_REPO_URL:-git@bitbucket.org:paytmteam/foundry-test-repo.git} \
	  $(BUN) test e2e/laptop-docs-real-llm.test.ts

test-web-e2e: build-web ## Run web end-to-end tests (Playwright against the web dashboard)
	@# `bunx --bun playwright test` runs Playwright under Bun, which is
	@# required: fixtures/web-server.ts uses Bun APIs (`import { spawn }
	@# from "bun"`, `import.meta.dir`, `Bun.sleep`) that Node can't parse.
	@# Using `npx playwright test` here produces a misleading
	@# "SyntaxError: Cannot use 'import.meta' outside a module" on every
	@# spec file.
	@cd packages/e2e && bun install --silent 2>/dev/null; \
	  bunx --bun playwright install chromium --with-deps 2>/dev/null; \
	  bunx --bun playwright test

test-e2e-web-dev: ## Run web e2e tests against running dev server (localhost:5173)
	@echo "Running Playwright e2e tests against localhost:5173..."
	@echo "Make sure the dev server is running: make dev"
	@cd packages/web && bunx --bun playwright install chromium --with-deps 2>/dev/null; \
	  bunx --bun playwright test

test-install: ## Run install.sh regression tests (docs/install.sh)
	@./scripts/tests/install/test-symlink-preservation.sh
	@./scripts/tests/install/test-installed-binary-runs.sh
	@./scripts/tests/install/test-api-failure-path.sh
	@./scripts/tests/install/test-installed-builtin-flows.sh
	@./scripts/tests/install/test-web-proxy-serves.sh
	@./scripts/tests/install/test-channel-subprocess.sh

test-watch: ## Run unit tests in watch mode
	$(BUN) test --watch

lint: ## Lint the codebase (ESLint + TypeScript)
	bunx --bun eslint packages/ --max-warnings 0

lint-fix: ## Auto-fix lint issues
	bunx --bun eslint packages/ --fix

drift: ## Check drizzle schema vs generated migrations (both dialects)
	$(BUN) x drizzle-kit check --config drizzle.config.ts
	DRIZZLE_DIALECT=postgres $(BUN) x drizzle-kit check --config drizzle.config.ts

format: ## Format code with Prettier
	bunx --bun prettier --write "packages/**/*.{ts,tsx,js,jsx,json,css}"

format-check: ## Check code formatting (CI gate)
	bunx --bun prettier --check "packages/**/*.{ts,tsx,js,jsx,json,css}"

docs-cli: ## Generate docs/cli-reference.md from the Commander.js command tree
	$(BUN) run scripts/generate-cli-docs.ts

docs-openrpc: ## Generate docs/openrpc.json from the Zod RPC schemas
	$(BUN) run scripts/generate-openrpc.ts

docs: docs-cli docs-openrpc ## Regenerate all auto-generated docs

# ── Building ─────────────────────────────────────────────────────────────────

build: build-cli build-web ## Build CLI binary + web frontend

build-cli: ## Build native macOS CLI binary (current arch)
	@echo "Building native binary..."
	@$(BUN) run scripts/inject-version.ts
	$(BUN) build --compile packages/cli/index.ts --outfile ark-native
	@echo "Built: ark-native ($$(du -h ark-native | cut -f1))"

build-web: ## Build web frontend (Vite production)
	@cd packages/web && npx vite build --logLevel error 2>/dev/null || $(BUN) run packages/web/build.ts

build-desktop: build-web ## Build Electron app with bundled ark-native
	@echo "Building ark-native for current platform..."
	@$(MAKE) build-cli --no-print-directory
	@mkdir -p packages/desktop/binaries/$$(uname -s | tr A-Z a-z)-$$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
	@cp ark-native packages/desktop/binaries/$$(uname -s | tr A-Z a-z)-$$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')/ark-native
	@echo "Bundled ark-native into packages/desktop/binaries/"
	cd packages/desktop && npm install --silent 2>/dev/null && npx electron-builder

# ── Packaging (all platforms) ────────────────────────────────────────────────

package: package-cli package-desktop ## Package CLI + Electron for all platforms

package-cli: build-web ## Build self-contained CLI bundles for macOS + Linux (4 targets)
	@echo "Building Ark bundles for all platforms..."
	@mkdir -p dist
	$(BUN) build --compile --target bun-darwin-arm64 packages/cli/index.ts --outfile dist/bin/ark-darwin-arm64
	$(BUN) build --compile --target bun-darwin-x64   packages/cli/index.ts --outfile dist/bin/ark-darwin-x64
	$(BUN) build --compile --target bun-linux-arm64  packages/cli/index.ts --outfile dist/bin/ark-linux-arm64
	$(BUN) build --compile --target bun-linux-x64    packages/cli/index.ts --outfile dist/bin/ark-linux-x64
	@echo ""
	@echo "Downloading vendored binaries..."
	@$(MAKE) vendor-tmux vendor-tensorzero vendor-codegraph vendor-goose vendor-codex vendor-codebase-memory-mcp --no-print-directory
	@echo ""
	@echo "Creating distribution tarballs..."
	@for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do \
	  mkdir -p dist/ark-$$plat/bin; \
	  cp dist/bin/ark-$$plat dist/ark-$$plat/bin/ark; \
	  cp -r agents runtimes flows skills mcp-configs dist/ark-$$plat/; \
	  if [ -f dist/vendor/tmux-$$plat ]; then cp dist/vendor/tmux-$$plat dist/ark-$$plat/bin/tmux; fi; \
	  if [ -f dist/vendor/tensorzero-$$plat ]; then cp dist/vendor/tensorzero-$$plat dist/ark-$$plat/bin/tensorzero-gateway; fi; \
	  if [ -f dist/vendor/codegraph-$$plat ]; then cp dist/vendor/codegraph-$$plat dist/ark-$$plat/bin/codegraph; fi; \
	  if [ -f dist/vendor/goose-$$plat ]; then cp dist/vendor/goose-$$plat dist/ark-$$plat/bin/goose; fi; \
	  if [ -f dist/vendor/codex-$$plat ]; then cp dist/vendor/codex-$$plat dist/ark-$$plat/bin/codex; fi; \
	  if [ -f dist/vendor/codebase-memory-mcp-$$plat ]; then cp dist/vendor/codebase-memory-mcp-$$plat dist/ark-$$plat/bin/codebase-memory-mcp; fi; \
	  cd dist && tar czf ark-$$plat.tar.gz ark-$$plat && cd ..; \
	  echo "  dist/ark-$$plat.tar.gz ($$(du -h dist/ark-$$plat.tar.gz | cut -f1))"; \
	done

vendor-tmux: ## Build static tmux binaries (native platform; cross-platform in CI)
	@mkdir -p dist/vendor
	@echo "  tmux: building static binaries..."
	@for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do \
	  ./scripts/vendor-tmux.sh $$plat || echo "  tmux-$$plat: skipped"; \
	done

vendor-codegraph: ## Extract codegraph native binaries from npm packages
	@mkdir -p dist/vendor
	@echo "  codegraph: extracting native binaries from npm..."
	@for pkg_plat in darwin-arm64 darwin-x64 linux-arm64-gnu linux-x64-gnu; do \
	  dist_plat=$$(echo $$pkg_plat | sed 's/-gnu//'); \
	  pkg="@optave/codegraph-$$pkg_plat"; \
	  pkg_dir="node_modules/@optave/codegraph-$$pkg_plat"; \
	  if [ -d "$$pkg_dir" ]; then \
	    bin=$$(find "$$pkg_dir" -name "codegraph*" -type f -perm +111 2>/dev/null | head -1); \
	    if [ -n "$$bin" ]; then \
	      cp "$$bin" "dist/vendor/codegraph-$$dist_plat"; \
	      echo "  codegraph-$$dist_plat: extracted"; \
	    else \
	      echo "  codegraph-$$dist_plat: binary not found in $$pkg_dir"; \
	    fi; \
	  else \
	    echo "  codegraph-$$dist_plat: npm package not installed (bun add $$pkg)"; \
	  fi; \
	done

vendor-goose: ## Download goose binaries from block/goose GitHub releases
	@mkdir -p dist/vendor
	@echo "  goose: downloading release binaries..."
	@for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do \
	  ./scripts/vendor-goose.sh $$plat || echo "  goose-$$plat: skipped"; \
	done

vendor-codex: ## Download codex binaries from openai/codex GitHub releases
	@mkdir -p dist/vendor
	@echo "  codex: downloading release binaries..."
	@for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do \
	  ./scripts/vendor-codex.sh $$plat || echo "  codex-$$plat: skipped"; \
	done

vendor-codebase-memory-mcp: ## Download codebase-memory-mcp binaries from DeusData GitHub releases
	@mkdir -p dist/vendor
	@echo "  codebase-memory-mcp: downloading release binaries..."
	@for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do \
	  ./scripts/vendor-codebase-memory-mcp.sh $$plat || echo "  codebase-memory-mcp-$$plat: skipped"; \
	done

vendor-tensorzero: ## Build TensorZero gateway from source for all platforms
	@mkdir -p dist/vendor
	@echo "  tensorzero: checking for pre-built binaries..."
	@# Build from source if cargo is available, otherwise skip
	@if command -v cargo >/dev/null 2>&1; then \
	  echo "  tensorzero: building from source (this takes a few minutes)..."; \
	  cd /tmp && git clone --depth 1 https://github.com/tensorzero/tensorzero.git tz-build 2>/dev/null || true; \
	  cd /tmp/tz-build && cargo build --release --bin gateway 2>/dev/null && \
	  cp target/release/gateway $(CURDIR)/dist/vendor/tensorzero-$$(uname -s | tr A-Z a-z)-$$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') && \
	  echo "  tensorzero: built successfully" || \
	  echo "  tensorzero: build failed (install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)"; \
	else \
	  echo "  tensorzero: skipped (install Rust to build, or use Docker for hosted mode)"; \
	fi

package-desktop: build-web ## Package Electron app (.dmg + .AppImage)
	cd packages/desktop && npm install --silent 2>/dev/null && npx electron-builder --mac --linux

# ── Other ────────────────────────────────────────────────────────────────────

clean: ## Remove all build artifacts
	rm -rf dist packages/web/dist packages/desktop/out packages/desktop/binaries node_modules/.cache
	rm -f ark-native ark-darwin-arm64 ark-darwin-x64 ark-linux-arm64 ark-linux-x64
	@echo "Cleaned."

uninstall: ## Remove the ark symlink from PATH
	rm -f $(ARK_BIN)
	@echo "Removed $(ARK_BIN)"
