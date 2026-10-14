# Build stage: the React frontend and the production node_modules.
FROM node:24-alpine AS ui-builder

# Keep in sync with "packageManager" in ui/package.json
ARG PNPM_VERSION=12.11.2
RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /build

COPY ui/package.json ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY ui/ .
RUN pnpm run build

# Server-only dependencies for the runtime image (no package manager needed there)
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod

# Runtime image.
FROM alpine:3.24

# OpenSSH serves remote Docker hosts and SSH tunnels; the PostgreSQL and MariaDB
# clients and MongoDB tools serve direct database servers. mongodb-tools comes from
# the community repository, which the alpine image enables by default.
RUN apk add --no-cache \
    bash \
    curl \
    docker-cli \
    mariadb-client \
    mongodb-tools \
    nodejs \
    openssh-client-default \
    postgresql18-client

WORKDIR /backups

COPY scripts/ /usr/local/bin/

# The pg-backup symlink exposes the same commands inside a running container
# (docker exec <ctr> pg-backup export ...).
RUN chmod +x /usr/local/bin/pg-export.sh \
              /usr/local/bin/pg-unblock.sh \
              /usr/local/bin/pg-delete.sh \
              /usr/local/bin/pg-create.sh \
              /usr/local/bin/pg-restore.sh \
              /usr/local/bin/entrypoint.sh \
 && ln -s entrypoint.sh /usr/local/bin/pg-backup

# Server, its production dependencies, and the built frontend
WORKDIR /ui
COPY ui/package.json ./
COPY --from=ui-builder /build/node_modules ./node_modules
COPY ui/server/ ./server/
COPY --from=ui-builder /build/dist ./dist

VOLUME ["/backups"]

ENV NODE_ENV=production

EXPOSE 3000

ENTRYPOINT ["entrypoint.sh"]
