# ─── Stage 1: Build the React frontend ───────────────────────────────────────
FROM node:20-alpine AS ui-builder

# Enable pnpm via corepack (ships with Node 20)
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

COPY ui/package.json ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY ui/ .
RUN pnpm run build

# ─── Stage 2: Runtime image ───────────────────────────────────────────────────
FROM alpine:3.21

# Install bash, curl, docker CLI, postgresql-client, and Node.js
RUN apk add --no-cache \
    bash \
    curl \
    docker-cli \
    nodejs \
    npm \
    postgresql17-client

# Enable pnpm via corepack
RUN npm install -g corepack && corepack enable && corepack prepare pnpm@latest --activate

# Create working directory for SQL dump files
WORKDIR /backups

# Copy the CLI scripts
COPY scripts/ /usr/local/bin/

# Make all scripts executable
RUN chmod +x /usr/local/bin/pg-export.sh \
              /usr/local/bin/pg-unblock.sh \
              /usr/local/bin/pg-delete.sh \
              /usr/local/bin/pg-create.sh \
              /usr/local/bin/pg-restore.sh \
              /usr/local/bin/entrypoint.sh

# Copy the server and install only production deps
WORKDIR /ui
COPY ui/package.json ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY ui/server/ ./server/
COPY --from=ui-builder /build/dist ./dist

VOLUME ["/backups"]

EXPOSE 3000

# Ensure the runtime working directory is /ui so node can resolve node_modules
WORKDIR /ui

ENTRYPOINT ["entrypoint.sh"]
