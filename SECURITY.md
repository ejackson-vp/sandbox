# Security policy

## Supported versions

`0.1.x` is the only supported line. This repository is an alpha reference
deployment, not a hosted service.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

**[github.com/ejackson-vp/sandbox/security/advisories/new](https://github.com/ejackson-vp/sandbox/security/advisories/new)**

Please do not open a public issue for a suspected vulnerability. Include the
affected component, version or commit, a reproduction, and the impact. We aim to
acknowledge within three business days. There is no bug bounty.

## Scope

In scope:

- control-plane authentication and authorization
- tenant isolation, or escape from a sandbox
- API input handling and resource limits
- payment, capability and settlement handling
- relay, egress-proxy and internal trust boundaries
- container, guest and manifest configuration

Out of scope:

- the mock facilitator, dev attestation key, or other credentials published by
  design for local development
- findings that require cluster-admin or node compromise; on Talos that is
  equivalent to cluster compromise and is documented in
  [security-guarantees.md](docs/security-guarantees.md)
- denial of service against a single-operator homelab deployment

## Safe harbour

Good-faith research on a deployment you own is welcome. Do not test against an
instance you do not operate.
