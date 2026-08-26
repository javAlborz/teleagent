#!/bin/bash
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C
export LC_ALL=C
unset DOCKER_HOST DOCKER_CONTEXT

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
test_root=$(mktemp -d /tmp/teleagent-media-ro-canary.XXXXXX)
chmod 0700 "$test_root"
export DOCKER_CONFIG="$test_root/docker-config"
mkdir -m 0700 "$DOCKER_CONFIG"
suffix=$$
drachtio_name="teleagent-drachtio-ro-canary-$suffix"
freeswitch_name="teleagent-freeswitch-ro-canary-$suffix"
drachtio_image='drachtio/drachtio-server:latest@sha256:c03001e7c01ead29d0026245d0b42a9ebc8eefb0ff9bd180f5ff1f72be6da457'
freeswitch_image='drachtio/drachtio-freeswitch-mrf:latest@sha256:7a6ce26834ff1b8eb27e97f3b9db72980a511e83ef01897097ca92a0f2d5eb62'
canary_secret='teleagent_canary_only_0123456789_ABCDEFGH'

cleanup() {
  /usr/bin/docker container rm --force "$drachtio_name" "$freeswitch_name" >/dev/null 2>&1 || true
  /usr/bin/rm -rf -- "$test_root"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'Read-only media image canary failed: %s\n' "$1" >&2
  for container in "$drachtio_name" "$freeswitch_name"; do
    /usr/bin/docker logs --tail 80 "$container" 2>&1 || true
  done
  exit 1
}

command -v /usr/bin/docker >/dev/null 2>&1 || fail 'Docker is unavailable'
for image in "$drachtio_image" "$freeswitch_image"; do
  /usr/bin/docker image inspect "$image" >/dev/null 2>&1 || fail 'an exact media image is absent'
done

/usr/bin/sed \
  -e "s/__DRACHTIO_SECRET__/$canary_secret/g" \
  -e 's/__DRACHTIO_EXTERNAL_IP__/127.0.0.1/g' \
  -e 's/__DRACHTIO_SIP_PORT__/15070/g' \
  -e 's/__DRACHTIO_SIP_TRANSPORT__/udp/g' \
  "$repo_root/deploy/voice-stack/drachtio.conf.xml.template" >"$test_root/drachtio.conf.xml"
/usr/bin/sed \
  -e "s/__FREESWITCH_SECRET__/$canary_secret/g" \
  "$repo_root/deploy/voice-stack/freeswitch-event-socket.conf.xml.template" \
  >"$test_root/event_socket.conf.xml"
chmod 0444 "$test_root/drachtio.conf.xml" "$test_root/event_socket.conf.xml"

/usr/bin/docker run --detach \
  --name "$drachtio_name" \
  --network none \
  --read-only \
  --memory 384m --memory-swap 384m --cpus 0.5 --pids-limit 128 \
  --ulimit core=0 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --log-driver local --log-opt max-size=10m --log-opt max-file=2 \
  --tmpfs /config:rw,noexec,nosuid,nodev,mode=0700,size=1048576 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=0700,size=16777216 \
  --mount "type=bind,src=$test_root/drachtio.conf.xml,dst=/etc/drachtio.conf.xml,readonly" \
  "$drachtio_image" drachtio -f /etc/drachtio.conf.xml >/dev/null

drachtio_ready=0
for _attempt in $(seq 1 40); do
  if /usr/bin/docker exec "$drachtio_name" /bin/bash -c \
    'exec 3<>/dev/tcp/127.0.0.1/9022' >/dev/null 2>&1; then
    drachtio_ready=1
    break
  fi
  /usr/bin/sleep 0.25
done
[ "$drachtio_ready" -eq 1 ] || fail 'drachtio did not open its loopback admin socket'
[ "$(/usr/bin/docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$drachtio_name")" = true ] ||
  fail 'drachtio root filesystem is writable'

/usr/bin/docker run --detach \
  --name "$freeswitch_name" \
  --network none \
  --read-only \
  --memory 768m --memory-swap 768m --cpus 0.75 --pids-limit 384 \
  --ulimit core=0 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --log-driver local --log-opt max-size=10m --log-opt max-file=2 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=0700,size=33554432 \
  --tmpfs /usr/local/freeswitch/db:rw,noexec,nosuid,nodev,mode=0700,size=67108864 \
  --tmpfs /usr/local/freeswitch/log:rw,noexec,nosuid,nodev,mode=0700,size=67108864 \
  --tmpfs /usr/local/freeswitch/recordings:rw,noexec,nosuid,nodev,mode=0700,size=268435456 \
  --tmpfs /usr/local/freeswitch/run:rw,noexec,nosuid,nodev,mode=0700,size=8388608 \
  --tmpfs /usr/local/freeswitch/sounds:ro,noexec,nosuid,nodev,mode=0555,size=1048576 \
  --mount "type=bind,src=$repo_root/freeswitch/entrypoint.sh,dst=/usr/local/bin/entrypoint-hermes-freeswitch.sh,readonly" \
  --mount "type=bind,src=$repo_root/freeswitch/mrf.xml,dst=/usr/local/freeswitch/conf/sip_profiles/mrf.xml,readonly" \
  --mount "type=bind,src=$repo_root/freeswitch/switch.conf.xml,dst=/usr/local/freeswitch/conf/autoload_configs/switch.conf.xml,readonly" \
  --mount "type=bind,src=$test_root/event_socket.conf.xml,dst=/usr/local/freeswitch/conf/autoload_configs/event_socket.conf.xml,readonly" \
  --entrypoint /usr/local/bin/entrypoint-hermes-freeswitch.sh \
  "$freeswitch_image" freeswitch >/dev/null

freeswitch_ready=0
for _attempt in $(seq 1 120); do
  if /usr/bin/docker exec "$freeswitch_name" /usr/local/freeswitch/bin/fs_cli \
    -H 127.0.0.1 -P 8021 -p "$canary_secret" -x status >/dev/null 2>&1; then
    freeswitch_ready=1
    break
  fi
  /usr/bin/sleep 0.5
done
[ "$freeswitch_ready" -eq 1 ] || fail 'FreeSWITCH did not answer its loopback event socket'
[ "$(/usr/bin/docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$freeswitch_name")" = true ] ||
  fail 'FreeSWITCH root filesystem is writable'

printf 'MEDIA_IMAGES_READ_ONLY_OK\n'
