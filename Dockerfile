# Ark -- multi-stage Dockerfile for hosted deployment
#
# Builds the Ark server with web UI, conductor, and all dependencies.
# Uses Bun runtime (required -- bun:sqlite, Bun.serve, etc.).

# ── Stage 1: Install dependencies ────────────────────────────────────────────

FROM oven/bun:1.3 AS deps
WORKDIR /app

# Build tools for transitive native modules (better-sqlite3 etc.). Only
# present in the deps stage; stripped from the final production image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── Stage 2: Build ───────────────────────────────────────────────────────────
#
# Bun runs TypeScript directly at runtime; no `tsc` compile required for
# the server itself. The build stage exists to:
#   1. produce the web UI bundle (packages/web/dist) via Vite
#   2. snapshot the source tree we copy into the runtime image
# Skipping `bun run build` (tsc) avoids fighting accumulated type drift
# in code paths we are not running.

FROM oven/bun:1.3 AS build
WORKDIR /app

# Native build tools for transitive deps (better-sqlite3 etc.) and Vite.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY agents/ agents/
COPY flows/ flows/
COPY skills/ skills/
COPY models/ models/
COPY ark ./ark

# Build web UI (Vite). Server code stays as .ts -- Bun runs it directly.
RUN if [ -f packages/web/vite.config.ts ]; then \
      cd packages/web && bunx vite build --logLevel error; \
    fi

# ── Stage 3: Production image ────────────────────────────────────────────────

FROM oven/bun:1.3-slim AS production
WORKDIR /app

# Install runtime system dependencies + Node (for npm-installed claude CLI).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    tmux \
    curl \
    ca-certificates \
    jq \
    nodejs \
    npm \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code@2.1.126 \
  && npm cache clean --force
# Pull kubectl from a multi-arch image (Docker Hub is Zscaler-trusted, dl.k8s.io is MITM-blocked).
COPY --from=bitnami/kubectl:latest /opt/bitnami/kubectl/bin/kubectl /usr/local/bin/kubectl

# Production node_modules come from the deps stage (no devDeps) --
# keeps the final image slim. Source comes from the build stage.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/bun.lock ./
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/ark ./ark

# Copy resource definitions (agents, flows, skills, models)
COPY --from=build /app/agents ./agents
COPY --from=build /app/flows ./flows
COPY --from=build /app/skills ./skills
COPY --from=build /app/models ./models

# Copy web UI build output (if it exists)
COPY --from=build /app/packages/web/dist ./packages/web/dist

# arkd shim for the per-session pod K8sCompute provisions. K8sCompute
# hardcodes `command: ["/bin/sh","-c","arkd || sleep infinity"]` and
# expects `arkd` on PATH. Real binary doesn't exist -- arkd is a Bun
# subcommand of the CLI. This shim execs the right thing.
RUN printf '#!/bin/sh\nexec bun /app/packages/cli/index.ts arkd "$@"\n' > /usr/local/bin/arkd \
 && chmod +x /usr/local/bin/arkd

# Create ark data directory
RUN mkdir -p /root/.ark

# Expose ports:
#   8420  - Web UI
#   19100 - Conductor (agent coordination)
#   8430  - LLM Router
EXPOSE 8420 19100 8430

# Health check via conductor
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:19100/health || exit 1

# Default: start Ark control plane (server --hosted). Bun runs the .ts
# entry point directly, no compile step required.
CMD ["bun", "packages/cli/index.ts", "server", "start", "--hosted", "--port", "8420"]
