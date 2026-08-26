FROM node:24-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies

WORKDIR /app/voice-app

# better-sqlite3 may need to compile when a matching prebuilt binary is not
# available for the exact Node patch release.
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY voice-app/package*.json ./
RUN npm ci --omit=dev

FROM node:24-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

# A promoted production image must set this to the exact reviewed source
# revision. The voice launcher compares the resulting OCI label with its
# root-owned release manifest before it projects any credential.
ARG TELEAGENT_SOURCE_REVISION
LABEL org.opencontainers.image.revision="${TELEAGENT_SOURCE_REVISION}"

WORKDIR /app/voice-app

COPY --from=dependencies /app/voice-app/node_modules ./node_modules

# Copy application code and the repo-root helper lib expected by voice-app.
COPY --chown=0:0 voice-app/ ./
COPY --chown=0:0 lib /app/lib

# Runtime-generated audio lives only in the private /tmp tmpfs. Static media is
# baked into the read-only image and cannot be replaced through a host bind.
RUN chmod -R go-w /app/voice-app/static

# HTTP API port
EXPOSE 3000
# WebSocket for audio streaming
EXPOSE 3001

CMD ["node", "index.js"]
