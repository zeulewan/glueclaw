#!/bin/sh
# One-line bootstrap for GlueClaw — clones repo then runs install.sh
set -e
command -v git >/dev/null 2>&1 || {
  echo "Error: git not found"
  exit 1
}
DEST="${HOME}/GIT/glueclaw"
if [ -d "$DEST" ]; then
  [ -d "$DEST/.git" ] || {
    echo "Error: $DEST exists but is not a git repo"
    exit 1
  }
  cd "$DEST" && git pull -q
else
  git clone -q https://github.com/zeulewan/glueclaw.git "$DEST"
fi
cd "$DEST" && sh install.sh
