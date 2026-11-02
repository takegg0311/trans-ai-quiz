#!/usr/bin/env bash
# ジングル SE がビルドコンテキストに含まれるか確認する。submit-build.sh から source する。
set -euo pipefail

_check_sound_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/sound"
_jingle_files=(set.WAV buzz.WAV correct.WAV wrong.WAV)
_missing=()

for _file in "${_jingle_files[@]}"; do
  if [[ ! -f "$_check_sound_dir/$_file" ]]; then
    _missing+=("$_file")
  fi
done

if ((${#_missing[@]} == 0)); then
  echo "Jingle SE: ${_jingle_files[*]} (will be included in the container image)"
  return 0 2>/dev/null || exit 0
fi

_require="${QUIZ_DEPLOY_REQUIRE_SOUND:-1}"
_message="Missing jingle SE in sound/: ${_missing[*]}. Place the four WAV files before deploy, or set QUIZ_DEPLOY_REQUIRE_SOUND=0 in deploy/.env to build without them."

if [[ "$_require" == "1" ]]; then
  echo "$_message" >&2
  return 1 2>/dev/null || exit 1
fi

echo "Warning: $_message" >&2
return 0 2>/dev/null || exit 0
