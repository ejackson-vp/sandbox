SHELL := /bin/bash
.DEFAULT_GOAL := help

KIND_CLUSTER ?= x402-sandbox
CONTEXT      := kind-$(KIND_CLUSTER)
API_URL      ?= http://localhost:8080
CONTROL_IMG  ?= x402-sandbox/control:dev
GUEST_IMG    ?= x402-sandbox/guest:dev
NAMESPACE    := sandbox-system
KUBECTL      := kubectl --context $(CONTEXT)

.PHONY: help up down build deploy demo demo-agent demo-timeout test test-unit test-integration security-test security-network guest guest-load logs clean fmt images

help:
	@echo "x402 sandbox sessions"
	@echo ""
	@echo "  make up             create kind cluster + Cilium + build images + deploy"
	@echo "  make build          build container images and the Go guest"
	@echo "  make deploy         load images into kind and apply manifests"
	@echo "  make demo           full paid workflow with a mock payment"
	@echo "  make demo-agent     same purchase driven by the x402 client SDK"
	@echo "  make demo-session   full multi-command session workflow"
	@echo "  make demo-expire    demonstrate lease expiration and cleanup"
	@echo "  make demo-timeout   demonstrate the per-command timeout"
	@echo "  make demo-lifecycle checkpoint a session, resume it, verify the workspace"
	@echo "  make demo-portability prove a node-pinned checkpoint fails fast when cordoned"
	@echo "  make test           unit + integration tests (real guest, no cluster)"
	@echo "  make security-test  network + isolation tests against the real cluster"
	@echo "  make benchmark-smoke / benchmark-startup / benchmark-startup-pool"
	@echo "  make benchmark-burst / benchmark-soak / benchmark-density"
	@echo "  make benchmark-workloads / benchmark-reliability / benchmark-report"
	@echo "  make logs           tail control-plane logs"
	@echo "  make down           delete the kind cluster"
	@echo ""

up:
	./deploy/kind/up.sh
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
	./deploy/kind/apply.sh
	$(KUBECTL) -n $(NAMESPACE) rollout status deploy/controller --timeout=180s
	$(KUBECTL) -n $(NAMESPACE) rollout status deploy/relay --timeout=120s
	$(KUBECTL) -n $(NAMESPACE) rollout status deploy/egress-proxy --timeout=120s
	$(KUBECTL) -n $(NAMESPACE) rollout status deploy/facilitator --timeout=120s
	$(KUBECTL) -n $(NAMESPACE) rollout status deploy/api --timeout=120s
	@echo "==> deployed; API at $(API_URL)"

demo: cli
	@echo "==> waiting for the API"
	@for i in $$(seq 1 60); do curl -fsS $(API_URL)/healthz >/dev/null 2>&1 && break; sleep 1; done
	node cli/dist/index.js run examples/hello.py --duration 5m --allow-insecure-dev --payment-mode mock --api-url $(API_URL)

demo-agent: cli
	node cli/dist/index.js agent-demo examples/hello.py --duration 5m --allow-insecure-dev --payment-mode mock --api-url $(API_URL)

demo-timeout: cli
	-./scripts/demo-timeout.sh

demo-session: cli
	./scripts/demo-session.sh

demo-expire: cli
	./scripts/demo-expire.sh

demo-lifecycle:
	npx tsx scripts/lifecycle-demo.ts

demo-portability:
	npx tsx scripts/lifecycle-portability.ts

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

# ---------------------------------------------------------------- benchmarks
BENCH := npx tsx benchmarks/harness/cli.ts

benchmark-smoke:
	$(BENCH) smoke

benchmark-startup:
	$(BENCH) startup --samples $(or $(SAMPLES),100)

benchmark-startup-cold:
	$(BENCH) startup --cold --image-ref $(IMAGE_REF) --samples $(or $(SAMPLES),10)

benchmark-startup-pool:
	POOL_SIZE=$(or $(POOL_SIZE),8) SAMPLES=$(or $(SAMPLES),100) ./scripts/benchmark-warm-pool.sh

benchmark-burst:
	POOL_SIZE=$(or $(POOL_SIZE),8) LEVELS=$(or $(LEVELS),10,25,50) ./scripts/benchmark-warm-pool-burst.sh

benchmark-soak:
	POOL_SIZE=$(or $(POOL_SIZE),8) DURATION=$(or $(DURATION),600) RATE=$(or $(RATE),0.5) ./scripts/benchmark-soak.sh

benchmark-lifecycle-soak:
	DURATION=$(or $(DURATION),300) RATE=$(or $(RATE),0.5) ./scripts/benchmark-lifecycle-soak.sh

benchmark-lifecycle:
	SIZES=$(or $(SIZES),0,32,256) SAMPLES=$(or $(SAMPLES),3) ./scripts/benchmark-lifecycle.sh

benchmark-density:
	$(BENCH) density --levels $(or $(LEVELS),1,5,10,25) --mode $(or $(MODE),idle) --max $(or $(MAX),25)

benchmark-density-stress:
	$(BENCH) density --levels $(or $(LEVELS),50) --mode $(or $(MODE),idle) --max $(or $(MAX),50) --yes

benchmark-workloads:
	$(BENCH) workloads

benchmark-reliability:
	$(BENCH) reliability

benchmark-report:
	python3 benchmarks/analysis/analyze.py --results benchmarks/results

security-test: security-network

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
