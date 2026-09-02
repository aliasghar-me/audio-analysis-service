#!/usr/bin/env bash
#
# Deploy audio-analysis-service to the VPS. Run from the repository root:
#
#   SSH_TARGET=root@168.231.79.73 ./deploy/deploy.sh
#
# Optionally SSH_KEY=~/.ssh/some_key.
#
# The source tree is copied and built on the server. That is the simple choice
# for a single small service with no registry set up: no CI, no GHCR, no image
# tags to keep straight. The cost is that a deploy occupies the server's CPU for
# the length of a Docker build, which for one box serving a take-home is fine
# and would not be for anything with traffic.
#
# Idempotent, and safe to re-run. It never touches .env.production, never
# removes a volume, and never edits anything outside /opt/audio-analysis.
set -euo pipefail

: "${SSH_TARGET:?set SSH_TARGET, e.g. root@168.231.79.73}"
REMOTE_DIR=${REMOTE_DIR:-/opt/audio-analysis}
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
[[ -n ${SSH_KEY:-} ]] && SSH_OPTS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
remote() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }

say "Checking the server has what it needs"
remote 'set -e
  command -v docker >/dev/null || { echo "docker is not installed"; exit 1; }
  docker compose version >/dev/null || { echo "docker compose v2 is not installed"; exit 1; }
  docker network inspect "$(docker ps --filter name=traefik --format "{{.Names}}" | head -1)" >/dev/null 2>&1 || true
  echo "docker $(docker --version | cut -d" " -f3 | tr -d ,)"
  echo "traefik container: $(docker ps --filter name=traefik --format "{{.Names}}" | head -1 || echo NONE)"'

say "Creating $REMOTE_DIR (leaving anything already there alone)"
remote "install -d -m 0755 '$REMOTE_DIR'"

say "Syncing the source tree"
# --delete keeps the server from accumulating files deleted in the repo, and the
# excludes below are what keep .env.production and the storage volume safe from
# it. Adding a path here without adding it to the excludes is how a deploy
# script deletes production data; do not do that.
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '**/node_modules/' \
  --exclude 'dist/' \
  --exclude '.next/' \
  --exclude 'coverage/' \
  --exclude 'reports/' \
  --exclude '.stryker-tmp/' \
  --exclude '/storage/' \
  --exclude '.env' \
  --exclude '.env.production' \
  -e "ssh ${SSH_OPTS[*]}" \
  ./ "$SSH_TARGET:$REMOTE_DIR/"

say "Checking .env.production exists on the server"
remote "set -e
  cd '$REMOTE_DIR'
  if [ ! -f .env.production ]; then
    cp deploy/.env.production.example .env.production
    chmod 600 .env.production
    echo
    echo 'A template was written to $REMOTE_DIR/.env.production.'
    echo 'Fill in POSTGRES_PASSWORD and DATABASE_URL, then re-run this script:'
    echo
    echo '    openssl rand -hex 24'
    echo
    exit 3
  fi
  chmod 600 .env.production
  grep -q '^POSTGRES_PASSWORD=.\+' .env.production || { echo 'POSTGRES_PASSWORD is empty in .env.production'; exit 3; }
  grep -q 'PASSWORD_HERE' .env.production && { echo 'DATABASE_URL still contains the PASSWORD_HERE placeholder'; exit 3; }
  echo 'ok'"

say "Building and starting"
remote "set -e
  cd '$REMOTE_DIR'
  docker compose --env-file .env.production -f deploy/compose.vps.yml up -d --build --remove-orphans
  # Removes untagged layers only. Never -a, never --volumes.
  docker image prune -f >/dev/null"

say "Waiting for both containers to report healthy"
remote "set -e
  cd '$REMOTE_DIR'
  for i in \$(seq 1 60); do
    api=\$(docker inspect -f '{{.State.Health.Status}}' audio-analysis-api 2>/dev/null || echo missing)
    web=\$(docker inspect -f '{{.State.Health.Status}}' audio-analysis-web 2>/dev/null || echo missing)
    [ \"\$api\" = healthy ] && [ \"\$web\" = healthy ] && { echo 'api=healthy web=healthy'; exit 0; }
    sleep 5
  done
  echo \"timed out: api=\$api web=\$web\"
  docker compose --env-file .env.production -f deploy/compose.vps.yml logs --tail 40 api web
  exit 1"

say "Deployed"
remote "cd '$REMOTE_DIR' && docker compose --env-file .env.production -f deploy/compose.vps.yml ps"
