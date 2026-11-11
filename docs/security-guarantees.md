# Security guarantees — what is enforced, what is not

Read this before making any claim about the system.

## 0. One sentence

The provider's **control plane, logs and payment layer** never see plaintext
commands, file contents or output. That does not extend to checkpoint storage: a
suspended session's workspace PVC is plaintext on the storage backend and
readable by the node/storage administrator
([ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md)). Isolation between
sandboxes comes from the **VM boundary** (Kata), not from cryptography, and there
is **no hardware root of trust**: a malicious operator could run a different
guest.

## 1. Guarantee matrix

| Property | `runc` (dev) | Kata VM (real deployment) |
| --- | --- | --- |
| No accounts / API keys | Enforced | Enforced |
| One settled payment -> one session | Enforced + tested | Enforced |
| Duplicate settlement / replay rejected | Enforced + tested | Enforced |
| A captured create request is not a permanent replay | Enforced + tested (challenge nonce TTL) | Enforced |
| API accepts only ciphertext | Enforced + tested | Enforced |
| Control-plane logs and database free of plaintext | Enforced + tested | Enforced |
| Suspended workspace PVC free of plaintext | **No** | **No** |
| Checkpoint encrypted at rest | **No** | **No** |
| Per-session ephemeral key exchange | Enforced | Enforced |
| Client verifies the session key binding | Enforced + tested | Enforced |
| Evidence is hardware-rooted | **No** | **No** |
| Guest memory unreadable by the host admin | **No** | No normal path; not a TEE |
| Shared kernel with the host | **Yes — not isolated** | No (guest kernel) |
| Network isolation (pods / API / nodes / metadata) | Enforced + packet-tested | Enforced |
| Proxy-only egress, private destinations denied | Enforced + tested | Enforced |
| No inbound sandbox networking | Enforced + tested | Enforced |
| Lease expiry enforced (guest + controller + k8s) | Enforced + tested | Enforced |
| Per-command timeout, process-tree kill | Enforced + tested | Enforced |
| Workspace confinement (paths, symlinks, archives) | Enforced + tested | Enforced |
| Disk quota / file-size limits | Enforced + tested | Enforced |
| No persistence after termination | Enforced by construction | Enforced |
| Supervisor keys hidden from customer code | Best effort (§4) | VM boundary |
| Capability survives a secret rotation | Enforced + tested | Enforced + tested |

"Enforced + tested" means there is a test in `tests/` that fails if the property
regresses. `make security-test` runs the packet-level ones against a live
cluster.

A capability is `HMAC(secret, paymentKey, clientCommitment)`, prefixed with the id
of the key that signed it. The API holds a signing key plus, during a rotation,
the previous one, so a capability issued before the rotation keeps verifying and
new ones are signed with the new key. Retiring a key rejects its id immediately.
The key material is still a Kubernetes Secret: there is no KMS/HSM and no
scheduled rotation; see [runbooks/secret-rotation.md](runbooks/secret-rotation.md).

The two checkpoint rows are not a gap in the ciphertext-only claim; they are the
end of it. Encryption covers transport and the data sealed inside it. A
suspendable session's files are written to its PVC as ordinary files — the guest
never encrypts them, so there is nothing to decrypt when the pod is gone. The
controller never mounts the PVC, which is why the control plane still holds no
plaintext; but "the control plane cannot read it" is not the same as "it is
encrypted". See [lifecycle.md](lifecycle.md#checkpoint-at-rest-expiry-and-backup)
and [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md).

### Payment proof is bound to a server challenge

A `PAYMENT-SIGNATURE` alone is not session authority: the paying wallet must also
sign `(paymentKey, clientPublicKey, clientNonce, challengeNonce)`, where
`challengeNonce` came from the 402 that this API issued and is burned on first
use (default TTL 180 s, `CHALLENGE_NONCE_TTL_MS`). Consequences:

- A stolen payment header cannot bind a session to another client key (F-02).
- A captured *complete* create request works only once, and only inside the
  challenge TTL. Before #47 it worked forever (F-07).
- A retry after a lost response still recovers the same entitlement, because the
  client reuses the payment payload and only re-signs the commitment.
- The nonce table is durable, TTL-pruned and count-capped
  (`CHALLENGE_NONCE_MAX_ACTIVE`, default 20 000). Issuing is unauthenticated, so
  the per-IP create bucket is the bound on how fast the table can grow.

Residual: an attacker who captures the *challenge and the signed request
together* and submits it before the real client does wins that race, exactly as
they would win a network race for any one-time token. There is still no
per-request proof of possession: a capability is a bearer token for its TTL.

## 2. There is no hardware root of trust

The guest signs a statement binding its ephemeral public key to the session id,
the client nonce and the client's public key. That signature is made with an
Ed25519 key whose seed ships in this repository
(`shared/src/dev-attestation.ts`), so **anyone can produce it**.

What the binding does prove:

- the key the client is about to seal commands to belongs to the guest that
  answered *this* session, with *this* nonce;
- a relay that swaps in a different guest key is detected;
- replay of another session's evidence is rejected.

What it does not prove:

- which software is running in the guest;
- that the operator is not running a modified guest.

Consequently every envelope carries `hardwareBacked: false` /
`insecureDevOnly: true`, and the API surfaces that in `status`. Do not describe
this system as confidential computing, attested, or provider-blind.

## 3. What encryption protects

Protected against:

- the API server, controller, relay, facilitator, database and Kubernetes API
  objects (none holds a decryption key),
- pod logs (guest logs record sizes, operation names and exit codes only),
- a passive observer of relay traffic,
- another customer (separate keys, sessions, pods, relay entries),
- a compromised payment layer.

Not protected against:

- the node/host administrator (in any mode available here), including reading or
  copying a suspended session's workspace PVC,
- a compromised guest supervisor (it must decrypt to execute),
- runtime side channels.

## 4. Supervisor hardening (shared-UID mode)

With `runc`, customer code and the supervisor share a UID. We do not pretend
that is isolation, so the supervisor adds:

| Control | Effect |
| --- | --- |
| `PR_SET_DUMPABLE=0` | the supervisor cannot be ptraced and `/proc/<pid>/mem` is unreadable by same-UID processes |
| bootstrap file (0400, deleted at startup) | relay token, signing key and proxy token never appear in the process environment or `/proc/1/environ` |
| credentials dropped after use | the relay token and signing key are cleared once the binding statement is produced |
| curated child environment | children inherit only a fixed base plus validated overrides; never the guest env |
| process group per command | `SIGKILL` to the group on timeout, cancel or lease end; background children do not survive |
| pod cgroup `pids.max` | per-sandbox process cap (kubelet `pod-max-pids=1024`) |
| workspace confinement | every path resolved inside the workspace; symlink parents rejected; writes use `O_NOFOLLOW` |
| archive validation | absolute paths, `..`, symlinks, hardlinks, devices and oversized members rejected |

Residual risk in this mode: a hostile program that runs as root on the node (or
finds a kernel bug) can read the supervisor's memory. Kata removes the shared
kernel. Nothing here removes the host.

## 5. Filesystem guarantees

- Ordinary sessions: the workspace is a memory-backed `emptyDir` and disappears
  with the pod.
- Suspendable sessions: the workspace is a per-session PVC, deleted on terminate,
  suspended expiry or max lifetime, and never reused. It is **plaintext**: no
  component encrypts it, the controller never mounts it, and there is no
  checkpoint key in the control plane. The node/storage administrator can read
  it, and the repository provides no at-rest encryption for the homelab's
  `local-path` storage. A labelled PVC that no session owns is reaped after
  `ORPHAN_PVC_GRACE_MS`. See
  [lifecycle.md](lifecycle.md#checkpoint-at-rest-expiry-and-backup) and
  [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md).
- Paths are canonicalised and must stay inside the workspace; `..` and symlink
  escapes are rejected for read, write, list and stat.
- Uploads are size- and quota-checked before writing; archives are validated
  entry by entry and bounded by the same limits.
- Downloads never export symlinks and are capped at `maxFileBytes`.
- No `hostPath`; no shared volume between sessions.
- Local HTTP services are reachable only through the sealed relay operation. The
  guest dials `127.0.0.1:<port>` and the port must belong to a running service;
  the API never sees a host, and there is no inbound pod route. See
  [http.md](http.md).

## 6. Termination guarantees (residual latency)

| Layer | Mechanism | Bound |
| --- | --- | --- |
| Guest watchdog | `context` deadline + process-group `SIGKILL` | exact command timeout / lease |
| Controller | persisted `lease_expires_at`, +2 s grace, then shutdown + delete | lease + ~2 s + delete latency |
| Kubernetes | `activeDeadlineSeconds = lease + maxCommand + 300` | backstop |
| Reaper | pods older than 15 min or without a live session | <= 15 min worst case |

Not a hard real-time guarantee: `SIGKILL`, kubelet deletion and CNI propagation
take time. A trusted node-level enforcer would be required for a hard bound.

## 7. Explicit non-claims

This is **not** zero-knowledge computation, **not** confidential computing, and
**not** attested. It is encrypted transport plus VM isolation. The provider sees
that a session existed, its size, timing, limits, and the payment identity. It is
not a defence against a malicious host, not an anonymity system, and not
production-ready for hostile multi-tenant code without a TEE.
