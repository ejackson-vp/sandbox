SHELL := /bin/bash
.DEFAULT_GOAL := help

KIND_CLUSTER ?= x402-sandbox
CONTEXT      := kind-$(KIND_CLUSTER)
API_URL      ?= http://localhost:8080
CONTROL_IMG  ?= x402-sandbox/control:dev
GUEST_IMG    ?= x402-sandbox/guest:dev
NAMESPACE    := sandbox-system
KUBECTL      := kubectl --context $(CONTEXT)

.PHONY: help up up-2w build images guest deploy demo demo-agent demo-timeout demo-session dev-scale demo-expire demo-lifecycle demo-capacity demo-placement demo-portability demo-faults demo-http-basic demo-http demo-python demo-browser demo-large-file demo-directory test-transfers test-control-faults test-workloads demo-sse demo-ws cli fmt test test-unit test-integration test-go verify verify-model typecheck lint-structure test-property docs-check assets demo-gif security-test security-isolation kata security-network logs clean down

help:
	@echo "x402 sandbox sessions"
	@echo ""
	@echo "  make up             create kind cluster + Cilium + build images + deploy"
	@echo "  make up-2w          recreate with two workers (portability tests only)"
	@echo "  make build          build container images and the Go guest"
	@echo "  make deploy         load images into kind and apply manifests"
	@echo "  make demo           full paid workflow with a mock payment"
	@echo "  make demo-agent     same purchase driven by the x402 client SDK"
	@echo "  make demo-placement two-worker least-allocated placement (make up-2w)"
	@echo "  make demo-session   full multi-command session workflow"
	@echo "  make dev-scale N    scale relay + egress-proxy to N and restart; no N prints the counts"
	@echo "  make demo-expire    demonstrate lease expiration and cleanup"
	@echo "  make demo-timeout   demonstrate the per-command timeout"
	@echo "  make demo-lifecycle checkpoint a session, resume it, verify the workspace"
	@echo "  make demo-portability prove a node-pinned checkpoint fails fast when cordoned"
	@echo "  make demo-faults   missing PVC + controller restart while suspended"
	@echo "  make demo-http     Node HTTP/SSE/WebSocket workload"
	@echo "  make demo-http-basic minimal Python server through the relay"
	@echo "  make demo-sse      stream SSE chunks through the relay"
	@echo "  make demo-ws       WebSocket echo through the relay"
	@echo "  make test           unit + integration tests (real guest, no cluster)"
	@echo "  make verify         build, typecheck, structure lint, unit + property + go tests"
	@echo "  make verify-model   model-check the lifecycle/payment/operation/fence state machines (TLA+)"
	@echo "  make docs-check     markdownlint + internal link check"
	@echo "  make assets         re-render docs/assets/social-preview.png"
	@echo "  make demo-gif       record docs/assets/demo.gif with vhs (needs a cluster)"
	@echo "  make security-test  network + isolation tests against the real cluster"
	@echo "  make kata           switch the deployment to the Kata microVM RuntimeClass"
	@echo "  make security-isolation  release-gate Kata + Cilium suites with digests"
	@echo "  benchmarks live in the sandbox-bench repository"
	@echo "  make logs           tail control-plane logs"
	@echo "  make down           delete the kind cluster"
	@echo ""

up:
	./deploy/kind/up.sh
	$(MAKE) build
	$(MAKE) deploy

# Recreate the cluster with two workers. Benchmark density/workloads assume a
# single worker, so use this for scheduling/portability tests only.
up-2w: down
	CLUSTER_CONFIG=$(PWD)/deploy/kind/cluster-2w.yaml ./deploy/kind/up.sh
	$(MAKE) build
	$(MAKE) deploy

build: images guest

images:
	docker build -f Dockerfile.control -t $(CONTROL_IMG) .
	docker build -f guest/Dockerfile -t $(GUEST_IMG) guest

guest:
	cd guest && go build -trimpath -o bin/x402-guest ./ && go build -trimpath -o bin/x402-netprobe ./cmd/netprobe

deploy:
	kind load docker-image $(CONTROL_IMG) --name $(KIND_CLUSTER)
	kind load docker-image $(GUEST_IMG) --name $(KIND_CLUSTER)
	CONTEXT="$(CONTEXT)" GUEST_IMAGE="$(GUEST_IMG)" ./deploy/kind/apply.sh
	$(KUBECTL) -n $(NAMESPACE) rollout status deploy/controller --timeout=180s
	$(KUBECTL) -n $(NAMESPACE) rollout status statefulset/relay --timeout=120s
	$(KUBECTL) -n $(NAMESPACE) rollout status statefulset/egress-proxy --timeout=120s
	$(KUBECTL) -n $(NAMESPACE) rollout status deploy/facilitator --timeout=120s
	$(KUBECTL) -n $(NAMESPACE) rollout status deploy/api --timeout=120s
	@echo "==> deployed; API at $(API_URL)"

demo: cli
	@echo "==> waiting for the API"
	@for i in $$(seq 1 60); do curl -fsS $(API_URL)/healthz >/dev/null 2>&1 && break; sleep 1; done
	node cli/dist/index.js run examples/hello.py --duration 5m --payment-mode mock --api-url $(API_URL)

demo-agent: cli
	node cli/dist/index.js agent-demo examples/hello.py --duration 5m --payment-mode mock --api-url $(API_URL)

demo-timeout: cli
	-./scripts/demo-timeout.sh

demo-session: cli
	./scripts/demo-session.sh

# `make dev-scale 2` passes the count as a goal, not a variable. The bare number
# is picked out of MAKECMDGOALS and declared a no-op goal, but only when it is
# numeric, so `make dev-scale 2 demo-session` still runs the real demo target.
DEV_SCALE_ARG := $(word 2,$(MAKECMDGOALS))
ifneq ($(shell echo '$(DEV_SCALE_ARG)' | grep -E '^[0-9]+$$'),)
$(DEV_SCALE_ARG):
	@:
endif

dev-scale:
	CONTEXT="$(CONTEXT)" NAMESPACE="$(NAMESPACE)" ./scripts/dev-scale.sh $(or $(N),$(DEV_SCALE_ARG))

demo-expire: cli
	./scripts/demo-expire.sh

demo-lifecycle:
	npx tsx scripts/lifecycle-demo.ts

demo-capacity:
	./scripts/demo-capacity.sh

demo-placement:
	./scripts/demo-placement.sh

demo-portability:
	npx tsx scripts/lifecycle-portability.ts

demo-faults:
	npx tsx scripts/lifecycle-faults.ts

demo-http-basic:
	npx tsx scripts/http-demo.ts

demo-http:
	npx tsx examples/node-http-service/workload.ts

demo-python:
	npx tsx examples/python-data-processing/workload.ts

demo-browser:
	npx tsx examples/browser-automation/workload.ts

demo-large-file:
	npx tsx examples/large-file.ts

demo-directory:
	npx tsx examples/directory-transfer.ts

test-transfers:
	npx vitest run tests/transfers

test-control-faults:
	TARGET=$(or $(TARGET),controller) SESSIONS=$(or $(SESSIONS),) SCENARIO=$(or $(SCENARIO),provisioning) ACTION=$(or $(ACTION),kill) PAUSE_MS=$(or $(PAUSE_MS),3000) REPEAT=$(or $(REPEAT),1) npx tsx scripts/control-faults.ts

test-workloads:
	npx vitest run tests/workloads tests/compatibility

# Suites CI used to skip: transfer protocol, workload fixtures, browser
# compatibility (skips without its image). No cluster or guest binary needed.
test-portable:
	npx vitest run tests/transfers tests/workloads tests/compatibility

demo-sse:
	npx tsx scripts/sse-demo.ts

demo-ws:
	npx tsx scripts/ws-demo.ts

cli:
	npm run build -w @x402s/shared
	npm run build -w @x402s/sdk
	npm run build -w @x402s/cli

fmt:
	npm run build
	cd guest && gofmt -w .

test: test-unit test-integration

test-unit:
	npx vitest run tests/unit

test-integration: cli guest
	GUEST_BINARY=$(PWD)/guest/bin/x402-guest npx vitest run tests/integration

# Everything a reviewer can run without a cluster.
verify: build typecheck lint-structure test-unit test-property test-portable test-go vet-go

# Exhaustive-over-interleavings check of the session lifecycle, payment intent,
# single-operation slot and capacity reservation. TLC is pinned; the first run
# downloads verification/.cache/tla2tools-1.7.4.jar and verifies its SHA-256.
verify-model:
	./verification/run-tlc.sh

typecheck:
	npm run typecheck

lint-structure:
	npm run lint:structure

test-property:
	npx vitest run tests/property

# The guest's own suite. Without it a guard in guest/internal/files or the
# envelope parser can be removed with every TypeScript gate still green.
test-go:
	cd guest && go test ./...

# go test runs only a subset of vet checks; struct tags are not in it.
vet-go:
	cd guest && go vet ./...
	@out=$$(cd guest && gofmt -l .); if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi

# Mirrors .github/workflows/docs.yml: same glob set, same lychee flags. The
# local target used to lint a smaller set and skip fragment checks, so a broken
# anchor could pass here and fail in CI.
docs-check:
	npx --yes markdownlint-cli2 "*.md" "docs/**/*.md" "deploy/**/*.md" "security-review/**/*.md" ".github/**/*.md"
	@if command -v lychee >/dev/null 2>&1; then \
		lychee --offline --no-progress --include-fragments --exclude-path node_modules \
			"*.md" "docs/**/*.md" "deploy/**/*.md" "security-review/**/*.md"; \
	else \
		echo "lychee not installed: skipping link check (CI runs it)"; \
	fi

assets: docs/assets/social-preview.png

docs/assets/social-preview.png: docs/assets/social-preview.svg scripts/render-assets.sh
	./scripts/render-assets.sh docs/assets/social-preview.svg docs/assets/social-preview.png

demo-gif:
	@command -v vhs >/dev/null 2>&1 || { echo "vhs not found: brew install vhs"; exit 1; }
	vhs docs/assets/demo.tape

security-test: security-network

security-isolation: guest
	ARTIFACTS=$(or $(ARTIFACTS),artifacts/isolation) ./scripts/isolation-gate.sh

# Switch the running deployment to the Kata microVM RuntimeClass. The overlay
# patches both the RuntimeClass handler and EXECUTION_MODE; the controller is
# restarted because the config is read at start-up. Release gate only (#44).
kata:
	KUSTOMIZE_DIR=$(PWD)/deploy/kata CONTEXT="$(CONTEXT)" GUEST_IMAGE="$(GUEST_IMG)" ./deploy/kind/apply.sh
	$(KUBECTL) -n $(NAMESPACE) rollout restart deploy/controller
	$(KUBECTL) -n $(NAMESPACE) rollout status deploy/controller --timeout=300s

security-network: guest cli
	GUEST_BINARY=$(PWD)/guest/bin/x402-guest \
	KIND_CLUSTER=$(KIND_CLUSTER) API_URL=$(API_URL) \
	npx vitest run tests/security

logs:
	$(KUBECTL) -n $(NAMESPACE) logs -l app=controller -f --tail=100 --prefix

clean:
	rm -rf shared/dist api/dist controller/dist cli/dist guest/bin

down:
	./deploy/kind/down.sh
