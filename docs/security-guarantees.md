# Security guarantees — what is enforced, what is simulated

Read this before making any claim about the system.

## 0. One sentence

The provider's **control plane, storage, logs and payment layer** never see
plaintext commands, file contents or output in any mode. Only a hardware TEE
(out of scope) protects the guest from the **infrastructure operator**.

## 1. Guarantee matrix

| Property | Mode A (kind, `runc`) | Mode B (Kata VM) | Future confidential (SEV-SNP/TDX) |
| --- | --- | --- | --- |
| No accounts / API keys | **Enforced** | Enforced | Enforced |
| One settled payment → one session | **Enforced + tested** | Enforced | Enforced |
| Duplicate settlement/replay rejected | **Enforced + tested** | Enforced | Enforced |
| API accepts only ciphertext | **Enforced + tested** | Enforced | Enforced |
| Control-plane logs/storage free of plaintext | **Enforced + tested** | Enforced | Enforced |
| Per-session ephemeral key exchange | **Enforced** | Enforced | Enforced |
| Customer verifies key binding | **Enforced + tested** | Enforced | Enforced |
| Attestation evidence is hardware-rooted | **NO — simulated** | **NO — simulated** | Designed; verifier unimplemented (fails closed) |
| Guest memory unreadable by host admin | **NO** | **NO** | Yes, with real hardware + Trustee |
| Shared kernel with the host | **YES (not isolated)** | No (guest kernel) | No |
| Network isolation (pods/API/nodes/metadata) | **Enforced + packet-tested** | Enforced | Enforced |
| Proxy-only egress, private destinations denied | **Enforced + tested** | Enforced | Enforced |
| No inbound sandbox networking | **Enforced + tested** | Enforced | Enforced |
| Lease expiry enforced (guest + controller + k8s) | **Enforced + tested** | Enforced | Enforced |
| Per-command timeout, process-tree kill | **Enforced + tested** | Enforced | Enforced |
| Workspace confinement (paths, symlinks, archives) | **Enforced + tested** | Enforced | Enforced |
| Disk quota / file-size limits | **Enforced + tested** | Enforced | Enforced |
| No persistence after termination | **Enforced by construction** | Enforced | Enforced |
| Supervisor keys hidden from customer code | **Best effort** (see §4) | VM boundary | Hardware boundary |

## 2. What "INSECURE_DEV_ONLY" means

Dev and Kata modes sign attestation evidence with an Ed25519 key whose seed is
committed to this repository. Anyone can forge it. Therefore:

- every envelope has `insecureDevOnly: true` / `hardwareBacked: false`,
- the CLI and SDK **refuse to run** without `allowInsecureDev` (or
  `requireHardware`, which this deployment cannot satisfy),
- `verifyAttestation` in `confidential` mode rejects it (`not_hardware_backed`),
- pods are annotated `x402.io/confidential: "false"`.

The override changes nothing about transport or control-plane opacity; it
acknowledges that the execution environment is not confidential.

## 3. What encryption protects

Protected against:

- the API server, controller, relay, facilitator, database and Kubernetes API
  objects (none holds a decryption key),
- pod logs (guest logs record sizes, operation names, exit codes only),
- a passive observer of the relay traffic,
- another customer (separate keys, sessions, pods, relay entries),
- a compromised payment layer.

Not protected against:

- the node/host administrator in dev and Kata modes,
- a compromised guest supervisor (it must decrypt to execute),
- runtime side channels.

## 4. Supervisor hardening (dev mode)

Customer code and the supervisor share a UID in dev mode. We do not assume that
is isolation, so the supervisor adds:

| Control | Effect |
| --- | --- |
| `PR_SET_DUMPABLE=0` | the supervisor cannot be ptraced and `/proc/<pid>/mem` cannot be read by same-UID processes |
| bootstrap file (0400, deleted at startup) | relay token, dev attestation key and proxy token never appear in the process environment or `/proc/1/environ` |
| credentials dropped after use | the relay token and signing key are cleared once the evidence is produced |
| curated child environment | children inherit only a fixed base + validated overrides; never the guest env |
| process group per command | `SIGKILL` to the group on timeout/cancel/lease end; background children do not survive |
| `RLIMIT_NPROC` | LUID process cap (`maxProcesses`) |
| workspace confinement | every path resolved inside the workspace; symlink parents rejected; writes use `O_NOFOLLOW` |
| archive validation | absolute paths, `..`, symlinks, hardlinks, devices, oversized members rejected |

Residual dev-mode risk: a hostile program that finds a kernel bug or runs as root
on the node can read the supervisor's memory. Kata (Mode B) removes the shared
kernel; hardware TEEs (future) remove the host. This is why the product must not
be advertised as provider-blind in dev/Kata.

## 5. Filesystem guarantees

- Workspace is a memory-backed `emptyDir`; it disappears with the pod.
- Paths are canonicalised and must stay inside the workspace; `..` and symlink
  escapes are rejected for read, write, list and stat.
- Uploads are size- and quota-checked before writing; archives are validated
  entry by entry and bounded by the same limits.
- Downloads never export symlinks and are capped at `maxFileBytes`.
- No hostPath, no PVC, no shared volume between sessions.

## 6. Termination guarantees (residual latency)

| Layer | Mechanism | Bound |
| --- | --- | --- |
| Guest watchdog | `context` deadline + process-group `SIGKILL` | exact command timeout / lease |
| Controller | persisted `lease_expires_at`, +2 s grace, then shutdown + delete | lease + ~2 s + delete latency |
| Kubernetes | `activeDeadlineSeconds = lease + maxCommand + 300` | backstop |
| Reaper | pods older than 15 min or without a live session | ≤ 15 min worst case |

Not a hard real-time guarantee: `SIGKILL`, kubelet deletion and CNI propagation
take time. A trusted node-level enforcer is required for a hard bound.

## 7. Explicit non-claims

This is **not** zero-knowledge computation. It is encrypted transport plus
(optionally) confidential computing. The provider sees that a session existed,
its size/timing/limits, and the payment identity. It is not a defence against a
malicious host in dev/Kata, not an anonymity system, and not production-ready.
