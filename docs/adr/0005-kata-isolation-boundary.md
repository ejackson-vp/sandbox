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
