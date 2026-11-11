/**
 * Runtime profile catalog: which guest images a session may ask for.
 *
 * A profile is a system-defined image plus the digest the controller pins it
 * to. Customers never choose an image, only a name, and a name is only valid if
 * this catalog lists it. `base` is always present and is the guest image from
 * `GUEST_IMAGE`/`GUEST_IMAGE_DIGEST`, so the historical default keeps working.
 */

/**
 * The profile every session gets when it does not ask for one. It is the
 * original guest image, whose toolchain is the union of the language profiles,
 * and it carries no `/runtimes/<name>` manifest.
 */
export const DEFAULT_RUNTIME_PROFILE = "base";

/**
 * One selectable runtime profile: a system-defined image plus the digest the
 * controller pins it to. Customers never choose an image, only a name from
 * this catalog.
 */
export interface RuntimeProfile {
  name: string;
  /** Configured image reference (tag or repo), used for diagnostics. */
  image: string;
  /** Immutable digest the profile must run. */
  digest: string;
  /** Reference used in the pod spec: `repo@sha256:…` when pinned. */
  imageRef: string;
}

export type RuntimeProfileCatalog = Record<string, RuntimeProfile>;

export const DEFAULT_GUEST_IMAGE = "x402-sandbox/guest:dev";
const PINNED_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DEV_PLACEHOLDER_DIGEST = /^sha256:(dev-)?unpinned/;

/**
 * Who is loading this configuration. Typed as a plain string so this module
 * does not import the controller's `Role` union and create a cycle.
 */
export interface DigestPolicy {
  kubeEnabled: boolean;
  role: string;
  allowInsecureDev: boolean;
}

/**
 * One digest rule for every image the controller runs, so a profile can never
 * be pinned more loosely than the base guest image.
 */
export function assertDigestAllowed(label: string, digest: string, policy: DigestPolicy): void {
  const devPlaceholder = DEV_PLACEHOLDER_DIGEST.test(digest);
  if (!devPlaceholder && !PINNED_DIGEST.test(digest)) {
    throw new Error(`${label} must be sha256:<64 hex> or the dev placeholder`);
  }
  if (!policy.allowInsecureDev && !PINNED_DIGEST.test(digest)) {
    throw new Error(
      `${label} must be a pinned sha256 digest when ALLOW_INSECURE_DEV is false`,
    );
  }
  // A cluster deployment must pull an immutable image, regardless of the
  // payment/attestation dev switch. The placeholder is only meaningful for the
  // local process provisioner, where no pod spec references the tag.
  // Only the controller provisions a guest Pod. The relay, proxy and
  // facilitator share this config loader but never reference the guest image,
  // so requiring a digest there only creates a startup failure with no
  // security benefit.
  if (policy.kubeEnabled && (policy.role === "controller" || policy.role === "all") && !PINNED_DIGEST.test(digest)) {
    throw new Error(
      `${label} must be a pinned sha256:<64 hex> digest when KUBERNETES_ENABLED is true; ` +
        "the dev placeholder is only valid for the local process provisioner (KUBERNETES_ENABLED=false)",
    );
  }
}

/**
 * Pull by digest whenever one is configured, dev mode or not. ALLOW_INSECURE_DEV
 * decides whether a digest is *required*; it must not decide whether a
 * configured digest is honoured. Honouring it is what stops a moved tag, or a
 * compromised controller, from changing the image running inside the VM.
 */
export function imageRefFor(image: string, digest: string): string {
  return PINNED_DIGEST.test(digest) ? `${image.replace(/:[^/:]+$/, "")}@${digest}` : image;
}

/** Profile names follow the guest's own rule: `[a-z][a-z0-9-]{0,31}`. */
const RUNTIME_PROFILE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

interface ProfileEntry {
  image: string;
  digest: string;
}

function parseProfileEntry(name: string, raw: unknown): ProfileEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`RUNTIME_PROFILES.${name} must be an object with image and digest`);
  }
  const entry = raw as { image?: unknown; digest?: unknown };
  if (typeof entry.image !== "string" || entry.image.trim() === "") {
    throw new Error(`RUNTIME_PROFILES.${name}.image must be a non-empty image reference`);
  }
  // A digest belongs in `digest`; a ref that already carries one would produce
  // `repo@sha256:…@sha256:…` when pinned here.
  if (entry.image.includes("@")) {
    throw new Error(
      `RUNTIME_PROFILES.${name}.image must not embed a digest; set image to the repository and digest separately`,
    );
  }
  if (typeof entry.digest !== "string" || entry.digest === "") {
    throw new Error(`RUNTIME_PROFILES.${name}.digest must be sha256:<64 hex> or the dev placeholder`);
  }
  return { image: entry.image.trim(), digest: entry.digest };
}

/**
 * `RUNTIME_PROFILES` is a JSON object mapping a profile name to
 * `{image, digest}`. `base` is not listed: it is always the guest image from
 * `GUEST_IMAGE`/`GUEST_IMAGE_DIGEST`, and redefining it here is an error so the
 * default profile can never be shadowed by a stray entry.
 */
export function parseRuntimeProfiles(
  env: NodeJS.ProcessEnv,
  guest: { image: string; digest: string; imageRef: string },
  policy: DigestPolicy,
): RuntimeProfileCatalog {
  // Null prototype: a profile called `constructor` must be an entry, not a
  // lookup through Object.prototype.
  const catalog = Object.create(null) as RuntimeProfileCatalog;
  catalog[DEFAULT_RUNTIME_PROFILE] = {
    name: DEFAULT_RUNTIME_PROFILE,
    image: guest.image,
    digest: guest.digest,
    imageRef: guest.imageRef,
  };
  const rawCatalog = env.RUNTIME_PROFILES;
  if (rawCatalog === undefined || rawCatalog.trim() === "") return catalog;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCatalog);
  } catch (err) {
    throw new Error(`RUNTIME_PROFILES must be valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RUNTIME_PROFILES must be a JSON object mapping profile names to {image, digest}");
  }
  for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!RUNTIME_PROFILE_NAME.test(name)) {
      throw new Error(
        `RUNTIME_PROFILES profile name ${JSON.stringify(name)} must match [a-z][a-z0-9-]{0,31}`,
      );
    }
    if (name === DEFAULT_RUNTIME_PROFILE) {
      throw new Error(
        "RUNTIME_PROFILES must not redefine base; base comes from GUEST_IMAGE and GUEST_IMAGE_DIGEST",
      );
    }
    const entry = parseProfileEntry(name, raw);
    assertDigestAllowed(`RUNTIME_PROFILES.${name}.digest`, entry.digest, policy);
    catalog[name] = {
      name,
      image: entry.image,
      digest: entry.digest,
      imageRef: imageRefFor(entry.image, entry.digest),
    };
  }
  return catalog;
}

/**
 * Resolve a session's runtime to a catalog entry, or null when the profile is
 * unknown. Callers must fail closed rather than fall back to `base`: running a
 * session on an image it did not ask for is worse than not running it.
 */
export function resolveRuntimeProfile(
  catalog: RuntimeProfileCatalog,
  runtime: string | null | undefined,
): RuntimeProfile | null {
  const name = sessionRuntime({ runtime });
  return catalog[name] ?? null;
}

/**
 * The runtime profile a session asked for, normalised to a catalog name:
 * missing and empty values fall back to `base` (the default), and an unknown
 * name is returned as-is so the caller can fail closed.
 *
 * Read through this accessor so the session-row field is consumed in exactly
 * one place; the row type itself is owned by the store.
 */
export type SessionRuntimeSource = object & { runtime?: string | null };

export function sessionRuntime(session: SessionRuntimeSource): string {
  const name = (session.runtime ?? "").trim().toLowerCase();
  return name === "" ? DEFAULT_RUNTIME_PROFILE : name;
}

/**
 * Value for the guest's `RUNTIME_PROFILE`. `base` means "no manifest": the base
 * image has no `/runtimes/<name>` directory, so an empty value is the only
 * correct answer and a profile name must not be invented for it.
 */
export function runtimeProfileEnv(profile: RuntimeProfile): string {
  return profile.name === DEFAULT_RUNTIME_PROFILE ? "" : profile.name;
}

