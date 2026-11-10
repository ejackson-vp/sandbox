#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
docker build -f Dockerfile.profile \
  --build-arg PROFILE=python \
  --build-arg RUNTIME_IMAGE=python:3.12-alpine@sha256:e064671ca452259bab50e8e2c7bd896e39e9a343bb06ca25234adf6fe18d0fc7 \
  -t x402-sandbox/profile-python:dev .
docker build -f Dockerfile.profile \
  --build-arg PROFILE=node \
  --build-arg RUNTIME_IMAGE=node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 \
  -t x402-sandbox/profile-node:dev .
