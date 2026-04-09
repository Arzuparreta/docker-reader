#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "ERROR: docker compose (plugin) or docker-compose is required." >&2
  exit 1
fi

usage() {
  cat <<'EOF'
Usage: ./recompose.sh [--no-rebuild] [--no-down] [--logs]

  --no-rebuild  Skip image build before starting
  --no-down   Do not bring the stack down first (just up)
  --logs      Follow logs after starting
EOF
}

REBUILD=1
NO_DOWN=0
FOLLOW_LOGS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rebuild) REBUILD=1; shift ;;
    --no-rebuild) REBUILD=0; shift ;;
    --no-down) NO_DOWN=1; shift ;;
    --logs) FOLLOW_LOGS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$NO_DOWN" -eq 0 ]]; then
  "${COMPOSE[@]}" down --remove-orphans
fi

UP_ARGS=(up -d --remove-orphans)
if [[ "$REBUILD" -eq 1 ]]; then
  UP_ARGS+=(--build)
fi

"${COMPOSE[@]}" "${UP_ARGS[@]}"

if [[ "$FOLLOW_LOGS" -eq 1 ]]; then
  "${COMPOSE[@]}" logs -f --tail=200
fi

