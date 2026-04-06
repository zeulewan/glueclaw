#!/bin/bash
# One-line installer for GlueClaw
set -e
DEST="${HOME}/GIT/glueclaw"
if [ -d "$DEST" ]; then
  cd "$DEST" && git pull -q
else
  git clone -q https://github.com/zeulewan/glueclaw.git "$DEST"
fi
cd "$DEST" && bash install.sh
