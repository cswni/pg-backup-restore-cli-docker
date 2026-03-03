FROM alpine:3.21

# Install bash, docker CLI, and postgresql-client
RUN apk add --no-cache \
    bash \
    curl \
    docker-cli \
    postgresql17-client

# Create working directory for SQL dump files
WORKDIR /backups

# Copy the entrypoint and operation scripts
COPY scripts/ /usr/local/bin/

# Make all scripts executable
RUN chmod +x /usr/local/bin/pg-export.sh \
              /usr/local/bin/pg-unblock.sh \
              /usr/local/bin/pg-delete.sh \
              /usr/local/bin/pg-create.sh \
              /usr/local/bin/pg-restore.sh \
              /usr/local/bin/entrypoint.sh

VOLUME ["/backups"]

ENTRYPOINT ["entrypoint.sh"]
CMD ["--help"]

