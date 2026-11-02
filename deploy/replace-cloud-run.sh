#!/usr/bin/env bash
set -euo pipefail

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcloud-env.sh
source "$_script_dir/gcloud-env.sh"

_manifest="${1:-$_script_dir/cloud-run.yaml}"
if [[ ! -f "$_manifest" ]]; then
  echo "Missing $_manifest. Run deploy/render-cloud-run.sh first." >&2
  exit 1
fi

gcloud run services replace "$_manifest" \
  --project "$GCP_PROJECT" \
  --region "$GCP_REGION"
