FROM node:24-alpine@sha256:2a49bdf71e9fd965a58c1703fd9ddd205b34e5782b692a72dd1d248abb0beb43 AS dependencies

WORKDIR /app/voice-app

# better-sqlite3 may need to compile when a matching prebuilt binary is not
# available for the exact Node patch release.
RUN apk add --no-cache g++ make python3

COPY voice-app/package*.json ./
RUN npm ci --omit=dev

FROM node:24-alpine@sha256:2a49bdf71e9fd965a58c1703fd9ddd205b34e5782b692a72dd1d248abb0beb43

# The generic Node image includes npm/yarn tooling that the production voice
# process never invokes. Remove that executable package-manager surface and
# pin the currently fixed Alpine OpenSSL libraries in the runtime stage.
RUN apk add --no-cache --no-scripts --upgrade \
      libcrypto3=3.5.8-r0 \
      libssl3=3.5.8-r0 \
    && rm -f /var/log/apk.log \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-v* \
    && rm -f \
      /usr/local/bin/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg

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

# Root-owned runtime sources and dependencies are admission-checked. Remove
# group/other write inherited from a shared source checkout as well as static
# media; generated audio lives only in the private /tmp tmpfs.
RUN chmod -R go-w /app

# HTTP API port
EXPOSE 3000
# WebSocket for audio streaming
EXPOSE 3001

CMD ["node", "index.js"]
