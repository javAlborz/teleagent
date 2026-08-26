#!/bin/bash
set -e

# The complete event-socket configuration, including its credential and
# loopback ACL, is rendered into a protected host runtime directory and mounted
# read-only. Never accept the credential in argv or environment variables.
event_socket_config=/usr/local/freeswitch/conf/autoload_configs/event_socket.conf.xml
if [ ! -f "$event_socket_config" ] || [ -L "$event_socket_config" ]; then
  echo 'Protected FreeSWITCH event-socket configuration is missing or unsafe.' >&2
  exit 1
fi

if [ "$1" = 'freeswitch' ]; then
  shift

  while :; do
    case $1 in
    -g|--g711-only)
      sed -i -e 's/global_codec_prefs=.*"/global_codec_prefs=PCMU,PCMA"/g' /usr/local/freeswitch/conf/vars.xml
      sed -i -e 's/outbound_codec_prefs=.*"/outbound_codec_prefs=PCMU,PCMA"/g' /usr/local/freeswitch/conf/vars.xml
      shift
      ;;

    --g711-only-alaw-preferred)
      sed -i -e 's/global_codec_prefs=.*"/global_codec_prefs=PCMA,PCMU"/g' /usr/local/freeswitch/conf/vars.xml
      sed -i -e 's/outbound_codec_prefs=.*"/outbound_codec_prefs=PCMA,PCMU"/g' /usr/local/freeswitch/conf/vars.xml
      shift
      ;;

    -s|--sip-port)
      if [ -n "$2" ]; then
        sed -i -e "s/sip_port=[[:digit:]]\\+/sip_port=$2/g" /usr/local/freeswitch/conf/vars_diff.xml
      fi
      shift
      shift
      ;;

    -t|--tls-port)
      if [ -n "$2" ]; then
        sed -i -e "s/tls_port=[[:digit:]]\\+/tls_port=$2/g" /usr/local/freeswitch/conf/vars_diff.xml
      fi
      shift
      shift
      ;;

    -e|--event-socket-port)
      echo 'FreeSWITCH event-socket settings must come from the protected fixed configuration.' >&2
      exit 1
      ;;

    -a|--rtp-range-start)
      if [ -n "$2" ]; then
        sed -i -e "s/name=\"rtp-start-port\" value=\".*\"/name=\"rtp-start-port\" value=\"$2\"/g" \
          /usr/local/freeswitch/conf/autoload_configs/switch.conf.xml
      fi
      shift
      shift
      ;;

    -z|--rtp-range-end)
      if [ -n "$2" ]; then
        sed -i -e "s/name=\"rtp-end-port\" value=\".*\"/name=\"rtp-end-port\" value=\"$2\"/g" \
          /usr/local/freeswitch/conf/autoload_configs/switch.conf.xml
      fi
      shift
      shift
      ;;

    --ext-rtp-ip)
      if [ -n "$2" ]; then
        sed -i -e "s/ext_rtp_ip=.*\"/ext_rtp_ip=$2\"/g" /usr/local/freeswitch/conf/vars_diff.xml
      fi
      shift
      shift
      ;;

    --ext-sip-ip)
      if [ -n "$2" ]; then
        sed -i -e "s/ext_sip_ip=.*\"/ext_sip_ip=$2\"/g" /usr/local/freeswitch/conf/vars_diff.xml
      fi
      shift
      shift
      ;;

    -p|--password)
      echo 'FreeSWITCH credentials are forbidden in process arguments.' >&2
      exit 1
      ;;

    --codec-answer-generous)
      sed -i -e 's/inbound-codec-negotiation" value="greedy/inbound-codec-negotiation" value="generous"/g' \
        /usr/local/freeswitch/conf/sip_profiles/mrf.xml
      shift
      ;;

    --codec-list)
      if [ -n "$2" ]; then
        sed -i -e "s/global_codec_prefs=.*\"/global_codec_prefs=$2\"/g" /usr/local/freeswitch/conf/vars.xml
        sed -i -e "s/outbound_codec_prefs=.*\"/outbound_codec_prefs=$2\"/g" /usr/local/freeswitch/conf/vars.xml
      fi
      shift
      shift
      ;;

    --username)
      if [ -n "$2" ]; then
        sed -i -e "s/value=\"Jambonz-Mediaserver\"/value=\"$2-Mediaserver\"/g" \
          /usr/local/freeswitch/conf/sip_profiles/mrf.xml
      fi
      shift
      shift
      ;;

    --advertise-external-ip)
      sed -i -e 's/ext-sip-ip" value=".*"/ext-sip-ip" value="$${ext_sip_ip}"/g' \
        /usr/local/freeswitch/conf/sip_profiles/mrf.xml
      sed -i -e 's/ext-rtp-ip" value=".*"/ext-rtp-ip" value="$${ext_rtp_ip}"/g' \
        /usr/local/freeswitch/conf/sip_profiles/mrf.xml
      shift
      ;;

    -l|--log-level)
      if [ -n "$2" ]; then
        sed -i -e "s/name=\"loglevel\" value=\".*\"/name=\"loglevel\" value=\"$2\"/g" \
          /usr/local/freeswitch/conf/autoload_configs/switch.conf.xml
      fi
      shift
      shift
      ;;

    --)
      shift
      break
      ;;

    *)
      break
      ;;
    esac
  done

  exec freeswitch "$@"
fi

exec "$@"
