#!/bin/sh
# Release helper: tags the current package.json version (signed) and pushes
# the tag — the release workflow then builds the vsix and publishes the
# GitHub Release. Run after committing the version bump.
set -eu

v=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
[ -n "$v" ] || { echo "version not found in package.json" >&2; exit 1; }

if git rev-parse -q --verify "refs/tags/v$v" >/dev/null; then
  echo "tag v$v already exists" >&2
  exit 1
fi

git tag -s "v$v" -m "v$v"
git push origin "v$v"
echo "tagged and pushed v$v — the release workflow will attach the vsix"
