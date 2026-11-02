#!/usr/bin/env bash
set -euo pipefail

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcloud-env.sh
source "$_script_dir/gcloud-env.sh"

_context="${1:-.}"
gcloud builds submit --project "$GCP_PROJECT" --region "$GCP_REGION" \
  --config "$_script_dir/cloudbuild.yaml" \
  --substitutions="_IMAGE=${CONTAINER_IMAGE}" \
  "$_context"
