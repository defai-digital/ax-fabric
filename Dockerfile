# ─── Stage 1: Rust + Node builder ────────────────────────────────────────────
FROM node:22-slim AS builder

# Install system deps for Rust + native builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    build-essential \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

# Install pnpm
RUN npm install -g pnpm@10.22.0

WORKDIR /build

# Copy manifests first for better layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/contracts/package.json        ./packages/contracts/
COPY packages/akidb-native/package.json     ./packages/akidb-native/
COPY packages/akidb/package.json            ./packages/akidb/
COPY packages/fabric-ingest/package.json    ./packages/fabric-ingest/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy full source
COPY packages ./packages

# Build Rust NAPI module for Linux
WORKDIR /build/packages/akidb-native
RUN pnpm build

# Build all TypeScript packages in dependency order
WORKDIR /build
RUN pnpm --filter @ax-fabric/contracts build \
 && pnpm --filter @ax-fabric/akidb build \
 && pnpm --filter @ax-fabric/fabric-ingest build

# ─── Stage 2: Production runtime ─────────────────────────────────────────────
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.22.0

WORKDIR /app

# Copy manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/contracts/package.json        ./packages/contracts/
COPY packages/akidb-native/package.json     ./packages/akidb-native/
COPY packages/akidb/package.json            ./packages/akidb/
COPY packages/fabric-ingest/package.json    ./packages/fabric-ingest/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts from builder
# contracts, akidb, fabric-ingest emit to dist/
COPY --from=builder /build/packages/contracts/dist         ./packages/contracts/dist
COPY --from=builder /build/packages/akidb/dist             ./packages/akidb/dist
COPY --from=builder /build/packages/fabric-ingest/dist     ./packages/fabric-ingest/dist
# akidb-native emits .node + JS wrappers directly into package root (no dist/)
COPY --from=builder /build/packages/akidb-native/*.node    ./packages/akidb-native/
COPY --from=builder /build/packages/akidb-native/index.js  ./packages/akidb-native/index.js
COPY --from=builder /build/packages/akidb-native/index.cjs ./packages/akidb-native/index.cjs
COPY --from=builder /build/packages/akidb-native/index.d.ts ./packages/akidb-native/index.d.ts

# Data directory for AkiDB storage
RUN mkdir -p /data
ENV AX_FABRIC_DATA_ROOT=/data

# Expose MCP and orchestrator ports
EXPOSE 18080 19090

ENTRYPOINT ["node", "/app/packages/fabric-ingest/dist/cli.js"]
CMD ["--help"]
