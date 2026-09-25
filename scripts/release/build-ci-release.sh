#!/usr/bin/env bash
# Build Teleagent release evidence only on the isolated Hephaestus CI guest.
# This script never deploys, installs, starts, imports on a target, or pushes.
set -euo pipefail
IFS=$'\n\t'
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export TZ=UTC
# The support CLI imports release_closure before the clean-tree gate. Keep
# Python from creating __pycache__ inside the checked-out release source.
export PYTHONDONTWRITEBYTECODE=1

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository_root="$(cd -- "${script_dir}/../.." && pwd -P)"
readonly support_script="${script_dir}/ci_release_support.py"
readonly ci_config="${script_dir}/ci-release-inputs.json"

fail() {
  printf 'teleagent release CI refused: %s\n' "$1" >&2
  exit 77
}

[[ "$#" -eq 0 ]] || fail 'this builder accepts no caller-controlled arguments'
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && \
   "${TELEAGENT_CI_RELEASE_BUILD:-}" == 1 ]] \
  || fail 'the release builder runs only in its explicit GitHub Actions lane'
[[ "${GITHUB_REPOSITORY:-}" == javAlborz/teleagent ]] \
  || fail 'the release builder is not running in the canonical repository'
[[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && \
   "${GITHUB_REF:-}" == refs/heads/main ]] \
  || fail 'release evidence runs only by manual dispatch of the default branch'
[[ "${RUNNER_NAME:-}" == hephaestus-ci-build-vm01-teleagent && \
   "${RUNNER_OS:-}" == Linux && "${RUNNER_ARCH:-}" == X64 ]] \
  || fail 'the release builder requires the exact Hephaestus linux/x64 ci-build guest'
[[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ && \
   "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ && \
   "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]] \
  || fail 'GitHub source or run identity is invalid'
[[ -n "${RUNNER_TEMP:-}" && "${RUNNER_TEMP}" == /* && \
   "${RUNNER_TEMP}" != / && -d "${RUNNER_TEMP}" ]] \
  || fail 'the runner temporary root is unavailable'
[[ -n "${GITHUB_WORKSPACE:-}" && "${GITHUB_WORKSPACE}" == /* ]] \
  || fail 'the GitHub workspace is invalid'
[[ "$(pwd -P)" == "${repository_root}" && "${repository_root}" == \
   "$(cd -- "${GITHUB_WORKSPACE}" && pwd -P)" ]] \
  || fail 'the builder must run from the exact checked-out workspace'

readonly required_tools=(
  awk chmod curl df docker git id install jq mkdir mktemp mv python3
  realpath rm sha256sum sort tar timeout xz
)
for tool in "${required_tools[@]}"; do
  command -v -- "${tool}" >/dev/null 2>&1 \
    || fail "the Hephaestus CI baseline is missing required tool ${tool}"
done

python3 "${support_script}" validate-config \
  || fail 'the source-owned release CI input contract is invalid'
[[ "$(jq -er '.runnerName' "${ci_config}")" == "${RUNNER_NAME}" ]] \
  || fail 'the workflow runner differs from the source-owned CI contract'
python3 "${support_script}" check-tools \
  || fail 'the pinned root-owned Syft or Trivy executable is unavailable or unsafe'
readonly syft_path="$(jq -er '.tools.syft.path' "${ci_config}")"
readonly trivy_path="$(jq -er '.tools.trivy.path' "${ci_config}")"
[[ "$(command -v -- syft)" == "${syft_path}" && \
   "$(command -v -- trivy)" == "${trivy_path}" ]] \
  || fail 'PATH does not resolve the fixed reviewed Syft and Trivy executables'
readonly syft_version="$(jq -er '.tools.syft.version' "${ci_config}")"
readonly syft_platform="$(jq -er '.tools.syft.platform' "${ci_config}")"
readonly syft_version_output="$("${syft_path}" version)"
[[ "$(awk '$1 == "Version:" {print $2}' <<< "${syft_version_output}")" == \
     "${syft_version}" && \
   "$(awk '$1 == "Platform:" {print $2}' <<< "${syft_version_output}")" == \
     "${syft_platform}" ]] \
  || fail 'the root-owned Syft reports an unexpected version or platform'
readonly trivy_version="$(jq -er '.tools.trivy.version' "${ci_config}")"
[[ "$("${trivy_path}" --version)" == "Version: ${trivy_version}" ]] \
  || fail 'the root-owned Trivy reports an unexpected version'

readonly source_revision="$(git rev-parse --verify 'HEAD^{commit}')"
readonly source_tree="$(git show -s --format=%T HEAD)"
readonly source_date_epoch="$(git show -s --format=%ct HEAD)"
[[ "${source_revision}" == "${GITHUB_SHA}" ]] \
  || fail 'checkout HEAD is not the exact workflow commit'
[[ "${source_tree}" =~ ^[a-f0-9]{40}$ && "${source_date_epoch}" =~ ^[0-9]{1,10}$ ]] \
  || fail 'the checked-out source tree or timestamp is invalid'
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] \
  || fail 'the checked-out source tree is not clean'
git diff --quiet --no-ext-diff -- \
  || fail 'the checked-out source tree has tracked changes'
git diff --cached --quiet --no-ext-diff -- \
  || fail 'the checked-out source index has changes'

python3 "${support_script}" check-providers \
  --manifest "${repository_root}/deploy/worker-session/provider-cli.manifest.json" \
  || fail 'the fixed root-owned provider CLI build inputs are unavailable or unreviewed'

readonly available_kib="$(df -Pk -- "${RUNNER_TEMP}" | awk 'NR == 2 {print $4}')"
[[ "${available_kib}" =~ ^[0-9]+$ && "${available_kib}" -ge 15728640 ]] \
  || fail 'the isolated CI guest requires at least 15 GiB free temporary space'
timeout --signal=TERM --kill-after=15s 30s docker info --format '{{.ServerVersion}}' >/dev/null \
  || fail 'the isolated CI Docker daemon is unavailable'
readonly sandbox_image="$(jq -er '.sandboxImage' "${ci_config}")"
readonly sandbox_digest="${sandbox_image##*@}"
sandbox_inspection="$(docker image inspect -- "${sandbox_image}" 2>/dev/null)" \
  || fail 'the pinned lifecycle sandbox image is not preloaded on the CI guest'
readonly sandbox_inspection
[[ "$(jq -er '.[0].Os + "/" + .[0].Architecture' <<< "${sandbox_inspection}")" == \
     linux/amd64 ]] \
  || fail 'the pinned lifecycle sandbox image platform drifted'
jq -e --arg digest "${sandbox_digest}" \
  'any(.[0].RepoDigests[]?; endswith("@" + $digest))' \
  <<< "${sandbox_inspection}" >/dev/null \
  || fail 'the lifecycle sandbox image is not bound to its reviewed registry digest'

readonly output_root="${RUNNER_TEMP}/teleagent-release-output"
[[ ! -e "${output_root}" && ! -L "${output_root}" ]] \
  || fail 'the release output path already exists'
readonly work_root="$(mktemp -d \
  "${RUNNER_TEMP}/teleagent-release.${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}.XXXXXX")"
case "$(realpath -e -- "${work_root}")" in
  "${RUNNER_TEMP}"/teleagent-release."${GITHUB_RUN_ID}"."${GITHUB_RUN_ATTEMPT}".*) ;;
  *) fail 'the private release work root escaped the runner temporary directory' ;;
esac

current_container_name=''
current_image_tag=''
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "${current_container_name}" ]]; then
    timeout --signal=TERM --kill-after=10s 30s \
      docker container rm --force -- "${current_container_name}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${current_image_tag}" ]]; then
    timeout --signal=TERM --kill-after=10s 30s \
      docker image rm --force -- "${current_image_tag}" >/dev/null 2>&1 || true
  fi
  if [[ -d "${work_root}" ]]; then
    chmod -R u+w -- "${work_root}" >/dev/null 2>&1 || true
    rm -rf -- "${work_root}"
  fi
  if [[ "${status}" -ne 0 && -d "${output_root}" ]]; then
    chmod -R u+w -- "${output_root}" >/dev/null 2>&1 || true
    rm -rf -- "${output_root}"
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

readonly source_archive="${work_root}/source.tar"
git archive --format=tar --output="${source_archive}" "${source_revision}"
[[ -s "${source_archive}" ]] || fail 'git archive produced no source tree'

extract_source() {
  local staging_root=$1
  mkdir -m 0700 -- "${staging_root}"
  (
    # git archive records reviewed 0644/0755 source modes. The builder's
    # private umask must not turn them into 0600/0700 when tests inspect units.
    umask 022
    tar --extract --file="${source_archive}" --directory="${staging_root}" \
      --no-same-owner --no-same-permissions
  )
}

run_lifecycle_sandbox() {
  local mode=$1
  local staging_root=$2
  local suffix=$3
  [[ "${mode}" == test || "${mode}" == stage ]] \
    || fail 'internal lifecycle sandbox mode is invalid'
  case "$(realpath -e -- "${staging_root}")" in
    "${work_root}"/*) ;;
    *) fail 'lifecycle sandbox source escaped the private work root' ;;
  esac
  [[ "${staging_root}" != *','* ]] \
    || fail 'lifecycle sandbox mount path contains an unsupported delimiter'

  local module_paths=()
  local tmpfs_options=rw,nosuid,nodev,noexec,size=1073741824,mode=1777
  if [[ "${mode}" == test ]]; then
    # Several integration tests execute fixture scripts from os.tmpdir().
    # This mount exists only in the throwaway, unprivileged test container.
    tmpfs_options=rw,nosuid,nodev,exec,size=1073741824,mode=1777
    module_paths=(
      node_modules
      cli/node_modules
      claude-api-server/node_modules
      voice-app/node_modules
      voice-app/audio-temp
      privileged-action-broker/node_modules
      realtime-sip-gateway/node_modules
    )
  else
    module_paths=(
      claude-api-server/node_modules
      privileged-action-broker/node_modules
      realtime-sip-gateway/node_modules
    )
  fi

  local docker_arguments=(
    run --rm --pull never
    --name "teleagent-release-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${suffix}"
    --platform linux/amd64
    --user "$(id -u):$(id -g)"
    --workdir /work
    --read-only
    --cap-drop ALL
    --security-opt no-new-privileges=true
    --network bridge
    --ipc none
    --pids-limit 256
    --cpus 2.0
    --memory 4g
    --memory-swap 4g
    --ulimit core=0
    --ulimit nofile=4096:4096
    --ulimit nproc=256:256
    --tmpfs "/tmp:${tmpfs_options}"
    --mount "type=bind,src=${staging_root},dst=/work,readonly"
    --entrypoint /usr/bin/env
  )
  local relative
  for relative in "${module_paths[@]}"; do
    [[ ! -e "${staging_root}/${relative}" && ! -L "${staging_root}/${relative}" ]] \
      || fail "lifecycle output mount ${relative} already exists"
    mkdir -m 0700 -p -- "${staging_root}/${relative}"
    docker_arguments+=(
      --mount "type=bind,src=${staging_root}/${relative},dst=/work/${relative}"
    )
  done
  current_container_name="teleagent-release-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${suffix}"
  timeout --signal=TERM --kill-after=30s 2400s \
    docker "${docker_arguments[@]}" "${sandbox_image}" -i \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      TELEAGENT_RELEASE_SANDBOX=1 \
      /bin/bash /work/scripts/release/run-ci-sandbox.sh "${mode}" /work
  current_container_name=''
}

readonly test_root="${work_root}/test-source"
extract_source "${test_root}"
run_lifecycle_sandbox test "${test_root}" tests
rm -rf -- "${test_root}"
python3 "${support_script}" check-tools \
  || fail 'pinned CI tools changed during the isolated test phase'

readonly node_archive="${work_root}/node-v24.19.0-linux-x64.tar.xz"
readonly node_parent="${work_root}/node-distribution"
readonly node_version="$(jq -er '.node.version' "${ci_config}")"
readonly node_modules_abi="$(jq -er '.node.modulesAbi' "${ci_config}")"
readonly node_archive_url="$(jq -er '.node.archiveUrl' "${ci_config}")"
readonly node_archive_sha="$(jq -er '.node.archiveSha256' "${ci_config}")"
readonly node_binary_sha="$(jq -er '.node.binarySha256' "${ci_config}")"
readonly node_archive_root="$(jq -er '.node.archiveRoot' "${ci_config}")"
mkdir -m 0700 -- "${node_parent}"
timeout --signal=TERM --kill-after=15s 300s \
  curl --disable --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --output "${node_archive}.new" "${node_archive_url}"
[[ "$(sha256sum -- "${node_archive}.new" | awk '{print $1}')" == "${node_archive_sha}" ]] \
  || fail 'the downloaded Node archive differs from its reviewed SHA-256'
mv -- "${node_archive}.new" "${node_archive}"
tar --extract --xz --file="${node_archive}" --directory="${node_parent}" \
  --no-same-owner --no-same-permissions
readonly node_root="${node_parent}/${node_archive_root}"
readonly node_bin="${node_root}/bin/node"
[[ -f "${node_bin}" && ! -L "${node_bin}" ]] \
  || fail 'the reviewed Node archive lacks its exact Node runtime file'
[[ "$(sha256sum -- "${node_bin}" | awk '{print $1}')" == "${node_binary_sha}" ]] \
  || fail 'the extracted Node interpreter differs from its reviewed SHA-256'
[[ "$("${node_bin}" --version)" == "${node_version}" && \
   "$("${node_bin}" -p 'process.versions.modules')" == "${node_modules_abi}" && \
   "$("${node_bin}" -p 'process.platform + "/" + process.arch')" == linux/x64 ]] \
  || fail 'the reviewed Node runtime reports unexpected version, ABI, or platform'

export GOMAXPROCS=2
export SYFT_CHECK_FOR_APP_UPDATE=false
export SYFT_PARALLELISM=2
export SYFT_FORMAT_CYCLONEDX_JSON_PRETTY=false
export TRIVY_NO_PROGRESS=true
export TRIVY_CACHE_DIR="${work_root}/trivy-cache"
export DOCKER_BUILDKIT=1
export SOURCE_DATE_EPOCH="${source_date_epoch}"

install_staged_dependencies() {
  local staging_root=$1
  local round=$2
  run_lifecycle_sandbox stage "${staging_root}" "${round}-stage"
  # Only package-local node_modules output mounts were writable in the
  # sandbox. Reject every link or xattr before a host-side copy follows a path.
  python3 "${support_script}" strip-metadata --root "${staging_root}"
  install -D -m 0755 -- "${node_bin}" "${staging_root}/runtime/node/bin/node"
  python3 "${support_script}" stage-providers \
    --manifest "${staging_root}/deploy/worker-session/provider-cli.manifest.json" \
    --staging-root "${staging_root}"
}

build_voice_image() {
  local image_tag=$1
  if docker image inspect -- "${image_tag}" >/dev/null 2>&1; then
    fail 'the exact temporary voice image tag already exists on the CI guest'
  fi
  current_image_tag="${image_tag}"
  timeout --signal=TERM --kill-after=30s 1800s \
    docker build --pull --no-cache --platform linux/amd64 \
      --build-arg "TELEAGENT_SOURCE_REVISION=${source_revision}" \
      --tag "${image_tag}" --file voice-app/Dockerfile .
  local inspection="${work_root}/image-inspection.json"
  docker image inspect -- "${image_tag}" > "${inspection}"
  local image_id
  image_id="$(jq -er '.[0].Id' "${inspection}")"
  [[ "${image_id}" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || fail 'the built voice image has no exact OCI config digest'
  [[ "$(jq -er '.[0].Os + "/" + .[0].Architecture' "${inspection}")" == linux/amd64 ]] \
    || fail 'the built voice image platform drifted'
  [[ "$(jq -er '.[0].Config.Labels["org.opencontainers.image.revision"]' \
       "${inspection}")" == "${source_revision}" ]] \
    || fail 'the built voice image source-revision label drifted'
  built_config_digest="${image_id}"
}

assemble_release() {
  local round=$1
  local image_tag=$2
  local config_digest=$3
  local staging_root="${work_root}/${round}/release"
  local build_input="${work_root}/${round}/build-input.json"
  local bundle="${work_root}/${round}/teleagent-release.tar"
  local raw_voice_sbom="${work_root}/${round}/voice-image.raw.cdx.json"
  local raw_release_sbom="${work_root}/${round}/teleagent-release.raw.cdx.json"
  mkdir -m 0700 -- "${work_root}/${round}"
  extract_source "${staging_root}"
  install_staged_dependencies "${staging_root}" "${round}"
  python3 "${support_script}" check-tools \
    || fail "pinned CI tools changed before ${round} SBOM generation"
  mkdir -p -- "${staging_root}/artifacts/voice" "${staging_root}/artifacts/sbom"
  docker image save --output \
    "${staging_root}/artifacts/voice/voice-image.docker.tar" "${image_tag}"
  python3 "${support_script}" write-voice-manifest \
    --destination "${staging_root}/artifacts/voice/voice-image.manifest.json" \
    --revision "${source_revision}" --config-digest "${config_digest}"
  timeout --signal=TERM --kill-after=20s 600s \
    "${syft_path}" scan "docker:${image_tag}" --source-name teleagent-voice \
      --source-version "${source_revision}" \
      --output "cyclonedx-json@1.6=${raw_voice_sbom}"
  python3 "${support_script}" normalize-sbom --source "${raw_voice_sbom}" \
    --destination "${staging_root}/artifacts/sbom/voice-image.cdx.json" \
    --forbid-path "${work_root}"
  timeout --signal=TERM --kill-after=20s 600s \
    "${syft_path}" scan "dir:${staging_root}" --source-name teleagent-release \
      --source-version "${source_revision}" \
      --output "cyclonedx-json@1.6=${raw_release_sbom}"
  python3 "${support_script}" normalize-sbom --source "${raw_release_sbom}" \
    --destination "${staging_root}/artifacts/sbom/teleagent-release.cdx.json" \
    --forbid-path "${work_root}"
  python3 "${support_script}" write-build-input --destination "${build_input}" \
    --revision "${source_revision}" --tree "${source_tree}"
  python3 "${support_script}" strip-metadata --root "${staging_root}"
  python3 "${script_dir}/generate-release-closure.py" \
    --root "${staging_root}" --build-input "${build_input}" \
    --expected-uid "$(id -u)" --expected-gid "$(id -g)" \
    --bundle "${bundle}" --source-date-epoch "${source_date_epoch}"
  python3 "${script_dir}/verify-release-closure.py" --root "${staging_root}" \
    --expected-uid "$(id -u)" --expected-gid "$(id -g)"
}

readonly image_tag="teleagent-voice-release:${source_revision}"
built_config_digest=''
build_voice_image "${image_tag}"
readonly first_config_digest="${built_config_digest}"
python3 "${support_script}" check-tools \
  || fail 'pinned CI tools changed before scanning and SBOM generation'
readonly trivy_scan="${work_root}/voice-image.trivy.json"
timeout --signal=TERM --kill-after=30s 1200s \
  "${trivy_path}" --cache-dir "${TRIVY_CACHE_DIR}" image --scanners vuln,secret \
    --severity HIGH,CRITICAL --exit-code 1 --format json \
    --output "${trivy_scan}" --no-progress "${image_tag}"
assemble_release first "${image_tag}" "${first_config_digest}"
timeout --signal=TERM --kill-after=10s 60s \
  docker image rm --force -- "${image_tag}" >/dev/null
current_image_tag=''

build_voice_image "${image_tag}"
readonly second_config_digest="${built_config_digest}"
[[ "${second_config_digest}" == "${first_config_digest}" ]] \
  || fail 'two clean voice-image builds produced different OCI config digests'
assemble_release second "${image_tag}" "${second_config_digest}"

python3 "${support_script}" compare \
  --first-root "${work_root}/first/release" \
  --first-bundle "${work_root}/first/teleagent-release.tar" \
  --second-root "${work_root}/second/release" \
  --second-bundle "${work_root}/second/teleagent-release.tar" \
  --scan "${trivy_scan}" --output "${output_root}"

printf 'TELEAGENT_NONPROMOTABLE_RELEASE_EVIDENCE_READY %s\n' \
  "$(jq -er '.releaseManifestSha256 + " " + .releaseBundleSha256' \
    "${output_root}/release-summary.json")"
