#!/usr/bin/env bash
set -euo pipefail
# Anchor 1.1.2, official amd64 image pinned by registry manifest digest.
IMAGE=quay.io/ottersec/anchor@sha256:0498f874d000db8fe9a4163e14c5584c82b4bf7a9aa7655b4c571e8fa67c99a0
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
git diff --quiet
git diff --cached --quiet
docker pull "$IMAGE"
mkdir -p dist/program/a dist/program/b target/deploy
for pass in a b; do
  docker run --rm --user 0 -e CARGO_TARGET_DIR=/tmp/target \
    -v "$ROOT:/workspace:ro" -v "$ROOT/dist/program/$pass:/out" \
    -v "$ROOT/dist/program/$pass:/workspace/target/deploy" \
    -w /workspace "$IMAGE" bash -lc '
      set -euo pipefail
      anchor --version
      cargo build-sbf --manifest-path programs/flip-the-meme/Cargo.toml --sbf-out-dir /out --tools-version v1.52 --arch v0 -- --locked
    '
done
cmp dist/program/a/flip_the_meme.so dist/program/b/flip_the_meme.so
# Generate IDL and test with one host compilation. The two SBF builds above remain
# fully independent; test/IDL compilation does not need another two copies of LiteSVM.
git archive HEAD > dist/program/source.tar
mkdir -p dist/program/idl-work
docker run --rm --user 0 -e CARGO_TARGET_DIR=/tmp/target \
  -v "$ROOT/dist/program:/out" -v "$ROOT/dist/program/idl-work:/workspace" \
  -w /workspace "$IMAGE" bash -lc '
    set -euo pipefail
    tar xf /out/source.tar -C /workspace
    rustup toolchain install 1.98.1 --profile minimal
    rustup default 1.98.1
    mkdir -p /tmp/target/deploy /workspace/target/deploy
    cp /out/a/flip_the_meme.so /workspace/target/deploy/flip_the_meme.so
    anchor idl build --program-name flip_the_meme --out /out/a/flip_the_meme.json -- --locked
    cargo test --locked --features idl-build --manifest-path programs/flip-the-meme/Cargo.toml
  '
sha256sum dist/program/a/flip_the_meme.so dist/program/a/flip_the_meme.json > dist/program/SHA256SUMS
git rev-parse HEAD > dist/program/source-commit.txt
printf '%s\n' "$IMAGE" > dist/program/build-image.txt
