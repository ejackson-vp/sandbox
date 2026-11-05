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
	@echo "x402 confidential sandbox"
	@echo ""
	@echo "  make up             create kind cluster + Cilium + build images + deploy"
	@echo "  make build          build container images and the Go guest"
	@echo "  make deploy         load images into kind and apply manifests"
	@echo "  make demo           full paid workflow with a mock payment"
	@echo "  make demo-agent     same purchase driven by the x402 client SDK"
	@echo "  make demo-timeout   demonstrate the 60s execution deadline"
	@echo "  make test           unit + integration tests (no cluster required)"
	@echo "  make security-test  network + isolation tests against the real cluster"
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
	node cli/dist/index.js run examples/hello.py --duration 60 --allow-insecure-dev --payment-mode mock --api-url $(API_URL)

demo-agent: cli
	node cli/dist/index.js agent-demo examples/hello.py --duration 60 --allow-insecure-dev --payment-mode mock --api-url $(API_URL)

demo-timeout: cli
	-node cli/dist/index.js run examples/forever.py --duration 3 --allow-insecure-dev --payment-mode mock --api-url $(API_URL)

cli:
	npm run build -w @x402s/shared
	npm run build -w @x402s/cli

fmt:
	npm run build
	cd guest && gofmt -w .

test: test-unit test-integration

test-unit:
	npx vitest run tests/unit

test-integration: cli guest
	GUEST_BINARY=$(PWD)/guest/bin/x402-guest npx vitest run tests/integration

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
