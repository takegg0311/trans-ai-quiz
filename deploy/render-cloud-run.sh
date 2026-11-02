#!/usr/bin/env bash
set -euo pipefail

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcloud-env.sh
source "$_script_dir/gcloud-env.sh"

_template="$_script_dir/cloud-run.yaml.tpl"
_output="$_script_dir/cloud-run.yaml"

_envsubst_vars='${GCP_PROJECT} ${GCP_REGION} ${CLOUD_RUN_SERVICE} ${RUN_SERVICE_ACCOUNT} ${CONTAINER_IMAGE} ${QUIZ_PUBLIC_URL} ${QUIZ_BUCKET} ${QUIZ_DATABASE} ${QUIZ_COLLECTION}'

envsubst "$_envsubst_vars" < "$_template" > "$_output"
echo "Wrote $_output"
