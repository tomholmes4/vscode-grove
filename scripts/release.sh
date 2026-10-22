#!/usr/bin/env bash
# Packages the extension and publishes it as a GitHub release tagged
# v<version>, unless a release for the package.json version already exists.
set -euo pipefail

cd "$(dirname "$0")/.."

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
tag="v$version"
vsix="$name-$version.vsix"

if gh release view "$tag" >/dev/null 2>&1; then
  echo "Release $tag already exists; bump the version in package.json to release again."
  exit 0
fi

# The release is tagged at HEAD, so the .vsix must be built from exactly what
# is pushed there.
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree has uncommitted changes; commit or stash them first." >&2
  exit 1
fi
git fetch --quiet origin
if [ -z "$(git branch -r --contains HEAD)" ]; then
  echo "HEAD isn't on origin yet; push it first." >&2
  exit 1
fi

npm run package -- --skip-license --out "$vsix"

gh release create "$tag" "$vsix" \
  --title "$tag" \
  --target "$(git rev-parse HEAD)" \
  --generate-notes
