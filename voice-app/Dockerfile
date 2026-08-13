FROM node:20-slim AS dependencies

WORKDIR /app/voice-app

# better-sqlite3 may need to compile when a matching prebuilt binary is not
# available for the exact Node patch release.
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY voice-app/package*.json ./
RUN npm ci --omit=dev

FROM node:20-slim

WORKDIR /app/voice-app

COPY --from=dependencies /app/voice-app/node_modules ./node_modules

# Copy application code and the repo-root helper lib expected by voice-app.
COPY voice-app/ ./
COPY lib /app/lib

# Create audio directory
RUN mkdir -p /app/voice-app/audio

# HTTP API port
EXPOSE 3000
# WebSocket for audio streaming
EXPOSE 3001

CMD ["node", "index.js"]
