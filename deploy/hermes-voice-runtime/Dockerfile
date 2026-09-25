ARG LEGACY_IMAGE
FROM ${LEGACY_IMAGE}
ARG BOOTSTRAP_SHA
COPY hermes-bootstrap.cjs /app/voice-app/hermes-bootstrap.cjs
LABEL org.teleagent.hermes-lifecycle="1"
LABEL org.teleagent.hermes-bootstrap-sha="${BOOTSTRAP_SHA}"
WORKDIR /app/voice-app
ENTRYPOINT ["/usr/local/bin/node", "/app/voice-app/hermes-bootstrap.cjs"]
CMD ["serve"]
