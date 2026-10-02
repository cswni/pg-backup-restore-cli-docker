# ─── Stage 1: Build the React frontend + production node_modules ─────────────
FROM node:24-alpine AS ui-builder

# Keep in sync with "packageManager" in ui/package.json
ARG PNPM_VERSION=12.8.1
RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /build

# pnpm-workspace.yaml holds the install-script policy (allowBuilds)
COPY ui/package.json ui/pnpm-lock.yaml ui/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY ui/ .
RUN pnpm run build

# Server-only dependencies for the runtime image (no package manager needed there)
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod

# ─── Stage 2: Runtime image ───────────────────────────────────────────────────
FROM alpine:3.24

# Install bash, curl, docker CLI, postgresql-client, and Node.js
RUN apk add --no-cache \
    bash \
    curl \
    docker-cli \
    nodejs \
    postgresql18-client

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

# Server, its production dependencies, and the built frontend
WORKDIR /ui
COPY ui/package.json ./
COPY --from=ui-builder /build/node_modules ./node_modules
COPY ui/server/ ./server/
COPY --from=ui-builder /build/dist ./dist

VOLUME ["/backups"]

EXPOSE 3000

# Ensure the runtime working directory is /ui so node can resolve node_modules
WORKDIR /ui

ENTRYPOINT ["entrypoint.sh"]
