#!/usr/bin/env bash
# Run dependency lifecycle scripts and tests only inside the throwaway CI container.
set -euo pipefail
IFS=$'\n\t'
umask 077

fail() {
  printf 'teleagent release sandbox refused: %s\n' "$1" >&2
  exit 77
}

[[ "$#" -eq 2 ]] || fail 'expected one fixed mode and one fixed workspace'
readonly mode=$1
readonly workspace=$2
[[ "${mode}" == test || "${mode}" == stage ]] || fail 'unsupported sandbox mode'
[[ "${workspace}" == /work && "$(pwd -P)" == /work ]] \
  || fail 'sandbox workspace is not the isolated /work mount'
[[ "${TELEAGENT_RELEASE_SANDBOX:-}" == 1 ]] \
  || fail 'explicit sandbox identity is absent'

readonly npm_cli=/usr/local/lib/node_modules/npm/bin/npm-cli.js
for tool in g++ make node python3 timeout; do
  command -v -- "${tool}" >/dev/null 2>&1 \
    || fail "pinned sandbox image lacks required tool ${tool}"
done
[[ -f "${npm_cli}" && ! -L "${npm_cli}" ]] || fail 'pinned sandbox npm CLI is unavailable'
[[ "$(node --version)" == v24.19.0 && \
   "$(node -p 'process.versions.modules')" == 137 && \
   "$(node -p 'process.platform + "/" + process.arch')" == linux/x64 ]] \
  || fail 'pinned sandbox Node version, ABI, or platform drifted'

mkdir -m 0700 -p -- /tmp/home /tmp/npm-cache /tmp/npm-prefix
: > /tmp/npm-userconfig
: > /tmp/npm-globalconfig
export HOME=/tmp/home
export CI=true
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export TZ=UTC
export MAKEFLAGS=-j2
export npm_config_audit=false
export npm_config_cache=/tmp/npm-cache
export npm_config_fund=false
export npm_config_globalconfig=/tmp/npm-globalconfig
export npm_config_jobs=2
export npm_config_prefix=/tmp/npm-prefix
export npm_config_update_notifier=false
export npm_config_userconfig=/tmp/npm-userconfig

npm_ci() {
  local directory=$1
  shift
  (
    cd -- "${directory}"
    timeout --signal=TERM --kill-after=20s 900s \
      node "${npm_cli}" ci --no-audit --no-fund "$@"
  )
}

if [[ "${mode}" == test ]]; then
  npm_ci /work --ignore-scripts
  npm_ci /work/cli --ignore-scripts
  npm_ci /work/claude-api-server
  npm_ci /work/voice-app
  npm_ci /work/privileged-action-broker
  npm_ci /work/realtime-sip-gateway
  timeout --signal=TERM --kill-after=30s 1200s node "${npm_cli}" test
  timeout --signal=TERM --kill-after=30s 600s node "${npm_cli}" run lint
  timeout --signal=TERM --kill-after=10s 300s python3 -m unittest -v \
    scripts/release/test_release_closure.py scripts/release/test_ci_release.py
  exit 0
fi

npm_ci /work/claude-api-server --omit=dev
npm_ci /work/privileged-action-broker --omit=dev
npm_ci /work/realtime-sip-gateway --omit=dev
python3 /work/scripts/release/ci_release_support.py prune-native --staging-root /work
(
  cd -- /work/claude-api-server
  node -e \
    'require("better-sqlite3"); require("node-pty"); process.stdout.write("api-native-runtime-ok\\n")'
)
(
  cd -- /work/privileged-action-broker
  node -e \
    'require("better-sqlite3"); process.stdout.write("privileged-broker-native-runtime-ok\\n")'
)
(
  cd -- /work/realtime-sip-gateway
  node --input-type=module -e \
    'await import("better-sqlite3"); await import("openai"); await import("ws"); process.stdout.write("realtime-sip-runtime-ok\\n")'
)
