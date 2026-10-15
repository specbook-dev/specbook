#!/usr/bin/env bash
# The Keycloak the real-provider OAuth suite (`pnpm test:oauth`) talks to, in Docker.
#
#   keycloak.sh up     start it and wait until it answers
#   keycloak.sh logs   show its log
#   keycloak.sh down   remove it
#
# KEYCLOAK_IMAGE (a 26.x image), KEYCLOAK_PORT and KEYCLOAK_CONTAINER override the defaults. The suite
# creates its own realm, client and user each run, so a plain `start-dev` is all it needs.
set -euo pipefail

NAME="${KEYCLOAK_CONTAINER:-specbook-keycloak}"
IMAGE="${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.7.3}"
PORT="${KEYCLOAK_PORT:-8080}"

case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:8080" \
      -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
      "$IMAGE" start-dev >/dev/null
    echo "Waiting for Keycloak on 127.0.0.1:${PORT} (${IMAGE}) ..."
    for _ in $(seq 1 90); do
      if curl -sf "http://127.0.0.1:${PORT}/realms/master/.well-known/openid-configuration" >/dev/null; then
        echo "Keycloak is ready."
        exit 0
      fi
      sleep 2
    done
    echo "Keycloak did not become ready in time; its log:" >&2
    docker logs "$NAME" 2>&1 | tail -60 >&2
    exit 1
    ;;
  logs)
    docker logs "$NAME"
    ;;
  down)
    docker rm -f "$NAME"
    ;;
  *)
    echo "usage: keycloak.sh up|logs|down" >&2
    exit 2
    ;;
esac
