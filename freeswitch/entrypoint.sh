#!/bin/bash
set -euo pipefail

# The complete event-socket configuration, including its credential and
# loopback ACL, is rendered into a protected host runtime directory and mounted
# read-only. Never accept the credential in argv or environment variables.
event_socket_config=/usr/local/freeswitch/conf/autoload_configs/event_socket.conf.xml
switch_config=/usr/local/freeswitch/conf/autoload_configs/switch.conf.xml
mrf_config=/usr/local/freeswitch/conf/sip_profiles/mrf.xml
for config in "$event_socket_config" "$switch_config" "$mrf_config"; do
  if [ ! -f "$config" ] || [ -L "$config" ]; then
    echo 'A protected FreeSWITCH configuration is missing or unsafe.' >&2
    exit 1
  fi
done

if [ "$#" -ne 1 ] || [ "$1" != 'freeswitch' ]; then
  echo 'FreeSWITCH accepts only its reviewed fixed entrypoint.' >&2
  exit 1
fi

# All mutable paths live on explicitly size-capped tmpfs mounts. Configuration
# is fixed and read-only, so no credential or media boundary can be changed in
# argv or the inherited environment.
exec freeswitch \
  -nf \
  -nonat \
  -nonatmap \
  -nocal \
  -nort \
  -conf /usr/local/freeswitch/conf \
  -log /usr/local/freeswitch/log \
  -run /usr/local/freeswitch/run \
  -db /usr/local/freeswitch/db \
  -temp /tmp \
  -recordings /usr/local/freeswitch/recordings \
  -storage /tmp/freeswitch-storage \
  -cache /tmp/freeswitch-cache \
  -sounds /usr/local/freeswitch/sounds
