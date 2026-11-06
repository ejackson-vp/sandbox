/**
 * Execution mode and attestation evidence shapes.
 */

export type ExecutionMode = "dev" | "kata" | "confidential";

export type EvidenceType = "dev-simulated" | "kata-dev-no-hw-attestation" | "sev-snp" | "tdx";

export interface AttestationClaims {
  /** Digest of the guest executable actually running. */
  guestMeasurement: string;
  /** Container image digest (immutable reference) reported by the runtime. */
  imageDigest: string;
  runtimeClass: string;
  /** Kernel identity. In a VM (Kata) this differs from the host kernel. */
  kernelRelease?: string;
  /** Tools available inside the sandbox (informational). */
  tools?: string[];
  /** True only for SEV-SNP/TDX evidence verified by a hardware verifier. */
  hardwareBacked: boolean;
  /** Guest-enforced management restrictions present? */
  guestPolicyEnforced: boolean;
  [key: string]: unknown;
}

export interface AttestationEnvelope {
  v: 1;
  evidenceType: EvidenceType;
  /**
   * Set by simulated evidence producers. A production verifier MUST reject any
   * envelope with this flag set, and the SDK must refuse it unless
   * `allowInsecureDev` was passed explicitly.
   */
  insecureDevOnly: boolean;
  hardwareBacked: boolean;
  sessionId: string;
  guestPublicKey: string;
  clientPublicKey: string;
  clientNonce: string;
  /** Random per-boot value; prevents replaying evidence across boots. */
  bootNonce: string;
  issuedAt: number;
  expiresAt: number;
  claims: AttestationClaims;
  /** Raw hardware evidence (base64). Empty for simulated modes. */
  report?: string;
  /** Signature over the canonical envelope (all fields except `signature`). */
  signature: {
    alg: "ed25519";
    keyId: string;
    value: string;
  };
}
