#!/usr/bin/env bash
set -euo pipefail
# Anchor 1.1.2, official amd64 image pinned by registry manifest digest.
IMAGE=quay.io/ottersec/anchor@sha256:0498f874d000db8fe9a4163e14c5584c82b4bf7a9aa7655b4c571e8fa67c99a0
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
docker pull "$IMAGE"
mkdir -p dist/program/a dist/program/b
for pass in a b; do
  docker run --rm --user 0 -e CARGO_TARGET_DIR=/tmp/target \
    -v "$ROOT:/workspace:ro" -v "$ROOT/dist/program/$pass:/out" \
    -w /workspace "$IMAGE" bash -lc '
      set -euo pipefail
      anchor --version
      cargo build-sbf --manifest-path programs/flip-the-meme/Cargo.toml --sbf-out-dir /out --tools-version v1.52 --arch v0 -- --locked
      anchor idl build --program-name flip_the_meme --out /out/flip_the_meme.json -- --locked
    '
done
cmp dist/program/a/flip_the_meme.so dist/program/b/flip_the_meme.so
cmp dist/program/a/flip_the_meme.json dist/program/b/flip_the_meme.json
sha256sum dist/program/a/flip_the_meme.so dist/program/a/flip_the_meme.json > dist/program/SHA256SUMS
git rev-parse HEAD > dist/program/source-commit.txt
printf '%s\n' "$IMAGE" > dist/program/build-image.txt
