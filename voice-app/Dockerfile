FROM node:20-slim

WORKDIR /app/voice-app

# Install dependencies first (better caching)
COPY voice-app/package*.json ./
RUN npm install --production

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
