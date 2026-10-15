#!/usr/bin/env bash
# Runs a command with a time limit and gives it one more try if it failed or stalled.
#
#   scripts/ci-retry.sh <seconds> <command> [args...]
#
# `a || a` only retries a command that exits; a browser run that stops answering never does, and would sit
# until the job's own limit. Here each attempt is cut off after <seconds>, and before the second one the
# processes still running are listed and the browser and test runner left over from the first are stopped, so
# they cannot slow the retry or the steps after it. A real failure fails both attempts.
set -u -o pipefail

limit="${1:?usage: ci-retry.sh <seconds> <command> [args...]}"
shift

attempt() {
  timeout --kill-after=15 "$limit" "$@"
}

attempt "$@" && exit 0

echo "::warning::'$*' failed or stalled (limit ${limit}s). Busiest processes now:"
ps -eo pid,ppid,pcpu,etime,args 2>/dev/null | sort -k3 -nr | head -12 | cut -c1-200
pkill -f chrome || true
pkill -f vitest || true
sleep 2

echo "Second attempt of '$*':"
attempt "$@"
