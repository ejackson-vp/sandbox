#!/usr/bin/env bash
# Full session demo:
#   pay -> create -> exec -> upload -> run -> create file -> read -> download
#   -> node -> destroy -> verify cleanup
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="node ${ROOT}/cli/dist/index.js"
API_URL="${API_URL:-http://localhost:8080}"
CONTEXT="${KUBECTL_CONTEXT:-kind-${KIND_CLUSTER:-x402-sandbox}}"
COMMON=(--api-url "${API_URL}" --allow-insecure-dev --payment-mode mock --quiet)
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

json_field() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(process.argv[1].split('.').reduce((o,k)=>o?.[k],j)??'')})" "$1"; }

step "1/11 creating a paid 5-minute session through the mock x402 facilitator"
CREATE_JSON="$(${CLI} create --tier standard "${COMMON[@]}" --json)"
SESSION_ID="$(printf '%s' "${CREATE_JSON}" | json_field sessionId)"
EXPIRES="$(printf '%s' "${CREATE_JSON}" | json_field status.leaseExpiresAt)"
PRICE="$(printf '%s' "${CREATE_JSON}" | json_field status.payment.priceUsd)"
if [ -z "${SESSION_ID}" ]; then echo "failed to create session"; exit 1; fi

step "2/11 session id and expiry"
echo "session:  ${SESSION_ID}"
echo "price:    ${PRICE} (mock payment)"
echo "expires:  ${EXPIRES}"

step "3/11 python3 --version"
${CLI} exec "${SESSION_ID}" "${COMMON[@]}" -- python3 --version

step "4/11 uploading a Python program"
${CLI} upload "${SESSION_ID}" "${ROOT}/examples/hello.py" /workspace/hello.py "${COMMON[@]}"

step "5/11 running the uploaded program"
${CLI} exec "${SESSION_ID}" "${COMMON[@]}" -- python3 /workspace/hello.py

step "6/11 creating a file from inside the sandbox"
${CLI} exec "${SESSION_ID}" "${COMMON[@]}" -- bash -c "echo 'artifact from the sandbox' > /workspace/output.txt && ls -l /workspace/output.txt"

step "7/11 reading that file in a separate execution"
${CLI} exec "${SESSION_ID}" "${COMMON[@]}" -- cat /workspace/output.txt

step "8/11 downloading the file to the local machine"
${CLI} download "${SESSION_ID}" /workspace/output.txt "${TMP}/output.txt" "${COMMON[@]}"
echo "local copy: $(cat "${TMP}/output.txt")"

step "9/11 running a Node.js script"
${CLI} upload "${SESSION_ID}" "${ROOT}/examples/hello.js" /workspace/hello.js "${COMMON[@]}"
${CLI} exec "${SESSION_ID}" "${COMMON[@]}" -- node /workspace/hello.js

step "10/11 destroying the session"
${CLI} destroy "${SESSION_ID}" "${COMMON[@]}"

step "11/11 verifying Kubernetes resources are gone"
for i in $(seq 1 40); do
  PODS="$(kubectl --context "${CONTEXT}" -n sandbox-workloads get pods -l "x402.io/session=${SESSION_ID}" --no-headers 2>/dev/null || true)"
  if [ -z "${PODS}" ]; then
    echo "no sandbox pods remain for ${SESSION_ID}"
    exit 0
  fi
  sleep 0.5
done
echo "error: sandbox pod still exists" >&2
kubectl --context "${CONTEXT}" -n sandbox-workloads get pods -l "x402.io/session=${SESSION_ID}" >&2 || true
exit 1
