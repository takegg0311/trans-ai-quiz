#!/usr/bin/env bash
# deploy/.env を読み込み、デプロイ用の変数を export する。他スクリプトから source する。
set -euo pipefail

_deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_env_file="${DEPLOY_ENV_FILE:-$_deploy_dir/.env}"

if [[ ! -f "$_env_file" ]]; then
  echo "Missing $_env_file. Copy deploy/.env.example to deploy/.env and fill values." >&2
  return 1 2>/dev/null || exit 1
fi

set -a
# shellcheck source=/dev/null
source "$_env_file"
set +a

_required=(
  GCP_PROJECT
  GCP_REGION
  CLOUD_RUN_SERVICE
  RUN_SERVICE_ACCOUNT
  QUIZ_PUBLIC_URL
  QUIZ_BUCKET
  QUIZ_DATABASE
  QUIZ_COLLECTION
)
for _name in "${_required[@]}"; do
  if [[ -z "${!_name:-}" ]]; then
    echo "Missing $_name in $_env_file" >&2
    return 1 2>/dev/null || exit 1
  fi
done

if [[ -z "${CONTAINER_IMAGE:-}" ]]; then
  if [[ -z "${IMAGE_TAG:-}" ]]; then
    echo "Set CONTAINER_IMAGE or IMAGE_TAG in $_env_file" >&2
    return 1 2>/dev/null || exit 1
  fi
  CONTAINER_IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/cloud-run-source-deploy/${CLOUD_RUN_SERVICE}:${IMAGE_TAG}"
  export CONTAINER_IMAGE
fi

export DEPLOY_DIR="$_deploy_dir"
