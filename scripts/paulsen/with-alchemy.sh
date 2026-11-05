#!/usr/bin/env bash
# Run a command against the Paulsen Cloudflare account using this repo's own
# Alchemy login (profile "paulsen").
#
#   scripts/paulsen/with-alchemy.sh pnpm alchemy login deploy/alchemy/alchemy.run.ts --profile paulsen
#   scripts/paulsen/with-alchemy.sh pnpm deploy:selfhost --yes --profile paulsen
#
# The alchemy CLI's --profile flag defaults to "default" and wins over
# $ALCHEMY_PROFILE, so always pass --profile paulsen to alchemy commands
# (deploy:selfhost forwards it to `alchemy deploy`). The env var below is still
# needed: the deploy preflight script reads it.
#
# Why the separate HOME: this repo pins alchemy 2.0.0-beta.61, which keeps
# logins in ~/.alchemy/profiles.json. Newer alchemy (beta.84+, used by other
# Paulsen repos) treats that file as legacy and, every time it runs, moves it
# and the whole ~/.alchemy/credentials folder into a backup. Sharing ~/.alchemy
# would keep logging this repo out, so its login lives in a dedicated home.
set -euo pipefail

ALCHEMY_HOME_DIR="${ALCHEMY_HOME_DIR:-$HOME/.alchemy-homes/open-seo}"
mkdir -p "$ALCHEMY_HOME_DIR"

export HOME="$ALCHEMY_HOME_DIR"
export ALCHEMY_PROFILE="${ALCHEMY_PROFILE:-paulsen}"

exec "$@"
