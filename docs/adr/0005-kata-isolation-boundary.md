# 0005. Kata microVMs as the isolation boundary

Status: accepted

## Context

The product runs arbitrary code from strangers. A shared-kernel container
runtime is not an acceptable boundary for that: a kernel bug or a misconfigured
capability is a host compromise, and the blast radius includes other tenants.

## Decision

Sandboxes run under Kata Containers with Cloud Hypervisor through a dedicated
`RuntimeClass`. Each session gets its own kernel and its own memory-backed
workspace. The base manifests use `runc` for local development, and the Kata
overlay is the supported path for anything beyond a laptop.

Isolation is treated as a property of the deployment, not of the application
code. The application cannot detect or compensate for a weak runtime.

`EXECUTION_MODE=kata` alone is a label, so the controller now checks the thing
the label claims. At startup, when Kubernetes is enabled and the mode is `kata`,
it reads the `RuntimeClass` named by `RUNTIME_CLASS` from the API server and
refuses to start unless its handler is a microVM one: `kata`, `kata-qemu`,
`kata-clh`, or whatever an operator lists in `KATA_RUNTIME_HANDLERS`. A missing
`RuntimeClass`, a read error, and a `runc`/`runsc`/unknown handler are all
startup failures, not warnings. This closes the silent downgrade: before it, a
drifted overlay could leave the configuration saying `kata` while every guest
ran on the host kernel, and nothing in the process could tell the difference.
The resolved handler is logged, exported as `sandbox_runtime_class_info`, and
echoed by `/internal/healthz`, so which runtime served a session stays
answerable after the fact. `EXECUTION_MODE=dev` and `KUBERNETES_ENABLED=false`
skip the check entirely: there is no RuntimeClass in that path and no claim to
verify.

## Consequences

- Escape requires a hypervisor or guest-kernel bug, not a container escape.
- Nodes must provide the Kata runtime; managed node pools often cannot.
- Memory overhead is real: about 182 MiB of host-side cost per idle guest
  (VM plus shim), which is why the warm pool is sized explicitly.
- Local `make up` does not exercise the same boundary as production, and the
  README says so rather than implying parity.

## Alternatives considered

- **`runc` with hardened seccomp.** Cheaper and universally available, but the
  boundary is the shared kernel.
- **gVisor.** Strong syscall interception, weaker on some workloads, and it moves
  the compatibility surface rather than removing it.
- **Firecracker directly.** A reasonable future direction; Kata is the current
  choice because it integrates with the container runtime interface and the
  existing Kubernetes deployment.
