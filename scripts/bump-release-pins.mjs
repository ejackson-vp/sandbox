#!/usr/bin/env node
/**
 * Move the deployment pins to a release, in one operation.
 *
 * Three files name the release the Talos overlay deploys, and they have to move
 * together: `deploy/talos/kustomization.yaml` (control tag, guest tag, guest
 * digest, profile digests), `deploy/release-pins.json` (the offline link between
 * a tag and a digest) and the Kyverno allowlist that admits those digests.
 * Updating them by hand is how v0.1.31 shipped 0.1.30 images: the tree was
 * internally consistent, and nothing compared it to the tag. This script exists
 * so the edit is one command instead of three hand edits, and so the tag check
 * added to `check-deploy-pins.mjs` has something mechanical to pass.
 *
 * Inputs, deliberately: the version and the digests. There is no registry
 * lookup, because a build-time registry answer is not reproducible and CI has no
 * credentials for it. The digests come from the release job's `digests` output
 * (or the GitHub Release / `profile-images.json` for a profile).
 *
 *   npm run release:bump-pins -- --version 0.1.32 \
 *     --guest-digest sha256:<64 hex> \
 *     --profile-digest python=sha256:<64 hex> \
 *     --profile-digest node=sha256:<64 hex>
 *
 * Every profile already in RUNTIME_PROFILES must be given a digest: a profile
 * that is silently left at the previous release is the same class of bug the
 * check is there to catch, and the check would fail anyway. Nothing is written
 * unless the rewritten files pass the same checks CI runs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_ROOT,
  FILES,
  comparePins,
  compareTag,
  parseKyvernoAdmitted,
  parseTalos,
  tagVersion,
} from "./check-deploy-pins.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const USAGE = [
  "usage: node scripts/bump-release-pins.mjs --version X.Y.Z --guest-digest sha256:<64 hex>",
  "         [--guest-version X.Y.Z] [--profile-digest name=sha256:<64 hex> ...] [--root <dir>]",
].join("\n");

/**
 * Rewrite the three documents for one release. Pure: takes the text of each
 * file, returns the new text, so the failure modes are unit-testable without a
 * checkout or a filesystem.
 */
export function bumpReleasePins({
  overlay,
  map,
  kyverno,
  version,
  guestVersion = null,
  guestDigest,
  profileDigests,
}) {
  const release = tagVersion(version);
  // The guest may lag by one release and normally does. A guest image stamps
  // the commit it was built from into a label, so the digest of the release
  // being cut cannot exist until after the commit that pins it, and a tree can
  // never contain its own digest. `--guest-version` names the guest that was
  // actually promoted, which on a control-only release is the previous one.
  const guestRelease = guestVersion === null || guestVersion === undefined
    ? release
    : tagVersion(guestVersion);
  const digests = normaliseProfileDigests(profileDigests);
  if (!DIGEST.test(String(guestDigest ?? ""))) {
    throw new Error(`guest digest ${guestDigest} is not a sha256:<64 hex> digest`);
  }

  // Parsing first is the shape check: if the overlay was restructured, this
  // throws here rather than writing a half-updated pin set.
  const current = parseTalos(overlay);
  const profileNames = Object.keys(current.profiles ?? {});
  for (const name of profileNames) {
    if (!(name in digests)) {
      throw new Error(
        `missing --profile-digest ${name}=sha256:…; the overlay pins the ${name} profile ` +
          `and a release cannot leave it at the previous one`,
      );
    }
  }
  for (const name of Object.keys(digests)) {
    if (!profileNames.includes(name)) {
      throw new Error(
        `--profile-digest ${name} given, but RUNTIME_PROFILES has no ${name} entry ` +
          `(it has: ${profileNames.join(", ") || "none"})`,
      );
    }
  }

  const guestImage = withoutTag(current.guestImage);
  const overlayWithImages = setGuestImage(overlay, guestImage, guestRelease);
  const overlayWithDigest = setGuestDigest(overlayWithImages, guestDigest);
  const overlayWithProfiles = setProfileDigests(overlayWithDigest, current.profiles, digests);
  const nextOverlay = setControlTag(overlayWithProfiles, release);

  const currentMap = JSON.parse(map);
  const nextMap = JSON.stringify(
    {
      ...currentMap,
      talos: {
        // Unknown keys are carried, not dropped: a comment or a future field in
        // the map is not this script's to delete.
        ...(currentMap.talos ?? {}),
        release,
        control: release,
        guest: guestRelease,
        guestDigest,
        profiles: Object.fromEntries(profileNames.map((name) => [name, digests[name]])),
      },
    },
    null,
    2,
  ).concat("\n");

  const nextKyverno = setAllowlist(kyverno, {
    release: guestRelease,
    guestImage,
    guestDigest,
    profileNames,
    digests,
  });

  // The same checks CI runs, against the text about to be written. A bump that
  // cannot pass them is a bad input, not something to commit and let CI find.
  // Parsing the serialized map rather than the object proves the round trip too.
  const nextTalos = JSON.parse(nextMap).talos;
  const nextParsedOverlay = parseTalos(nextOverlay);
  const errors = [
    ...comparePins(nextTalos, nextParsedOverlay, parseKyvernoAdmitted(nextKyverno)),
    ...compareTag(nextTalos, nextParsedOverlay, `v${release}`),
  ];
  if (errors.length > 0) {
    throw new Error(`bumped files do not agree; nothing written:\n  - ${errors.join("\n  - ")}`);
  }

  return { overlay: nextOverlay, map: nextMap, kyverno: nextKyverno };
}

/** Write the bump for a checkout, and return the new release map entry. */
export function bumpTree(root, options) {
  const files = {
    overlay: join(root, FILES.talos),
    map: join(root, FILES.pins),
    kyverno: join(root, FILES.kyverno),
  };
  const bumped = bumpReleasePins({
    overlay: readFileSync(files.overlay, "utf8"),
    map: readFileSync(files.map, "utf8"),
    kyverno: readFileSync(files.kyverno, "utf8"),
    version: options.version,
    guestDigest: options.guestDigest,
    profileDigests: options.profileDigests,
  });
  writeFileSync(files.overlay, bumped.overlay);
  writeFileSync(files.map, bumped.map);
  writeFileSync(files.kyverno, bumped.kyverno);
  return JSON.parse(bumped.map).talos;
}

/** `--version`, `--guest-digest`, optional `--guest-version`, repeated `--profile-digest`, `--root`. */
export function parseBumpArgs(argv) {
  const options = { version: null, guestVersion: null, guestDigest: null, profileDigests: {}, root: DEFAULT_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${name} needs a value\n${USAGE}`);
      index += 1;
      return value;
    };
    if (arg === "--version" || arg === "--release") {
      options.version = take(arg);
    } else if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg === "--guest-version") {
      options.guestVersion = take(arg);
    } else if (arg.startsWith("--guest-version=")) {
      options.guestVersion = arg.slice("--guest-version=".length);
    } else if (arg === "--guest-digest") {
      options.guestDigest = take(arg);
    } else if (arg.startsWith("--guest-digest=")) {
      options.guestDigest = arg.slice("--guest-digest=".length);
    } else if (arg === "--profile-digest") {
      addProfileDigest(options.profileDigests, take(arg));
    } else if (arg.startsWith("--profile-digest=")) {
      addProfileDigest(options.profileDigests, arg.slice("--profile-digest=".length));
    } else if (arg === "--root") {
      options.root = resolve(take(arg));
    } else {
      throw new Error(`unknown argument ${arg}\n${USAGE}`);
    }
  }
  if (!options.version) throw new Error(`--version is required\n${USAGE}`);
  if (!options.guestDigest) throw new Error(`--guest-digest is required\n${USAGE}`);
  return options;
}

function addProfileDigest(profiles, value) {
  const at = String(value).indexOf("=");
  if (at <= 0) throw new Error(`--profile-digest ${value} is not name=sha256:<64 hex>`);
  const name = value.slice(0, at);
  const digest = value.slice(at + 1);
  if (!DIGEST.test(digest)) {
    throw new Error(`--profile-digest ${name} digest ${digest} is not a sha256:<64 hex> digest`);
  }
  profiles[name] = digest;
}

function normaliseProfileDigests(profileDigests = {}) {
  const out = {};
  for (const [name, digest] of Object.entries(profileDigests)) {
    if (!DIGEST.test(String(digest))) {
      throw new Error(`profile ${name} digest ${digest} is not a sha256:<64 hex> digest`);
    }
    out[name] = digest;
  }
  return out;
}

/** `ghcr.io/owner/guest:0.1.30` -> `ghcr.io/owner/guest`. */
function withoutTag(image) {
  const value = String(image);
  const at = value.lastIndexOf(":");
  const slash = value.lastIndexOf("/");
  return at > slash ? value.slice(0, at) : value;
}

function replaceOnce(text, pattern, what, replacement) {
  const match = pattern.exec(text);
  if (!match) throw new Error(`could not find ${what}; the file shape changed`);
  return text.replace(pattern, replacement);
}

function setControlTag(text, release) {
  return replaceOnce(
    text,
    /(- name: x402-sandbox\/control\s*\n\s*newName: [^\n]+\n\s*newTag: )(\S+)/,
    "the control image's newTag",
    (_match, prefix) => `${prefix}${release}`,
  );
}

function setGuestImage(text, guestImage, release) {
  return replaceOnce(
    text,
    /(path: \/data\/GUEST_IMAGE\s*\n\s*value: )(\S+)/,
    "/data/GUEST_IMAGE",
    (_match, prefix) => `${prefix}${guestImage}:${release}`,
  );
}

function setGuestDigest(text, guestDigest) {
  return replaceOnce(
    text,
    /(path: \/data\/GUEST_IMAGE_DIGEST\s*\n\s*value: )(\S+)/,
    "/data/GUEST_IMAGE_DIGEST",
    (_match, prefix) => `${prefix}${guestDigest}`,
  );
}

function setProfileDigests(text, profiles, digests) {
  const entries = Object.entries(profiles ?? {});
  if (entries.length === 0) return text;
  const next = Object.fromEntries(
    entries.map(([name, entry]) => {
      if (typeof entry.image !== "string" || entry.image.length === 0) {
        throw new Error(`RUNTIME_PROFILES.${name} has no image; refusing to guess one`);
      }
      return [name, { image: withoutTag(entry.image), digest: digests[name] }];
    }),
  );
  return replaceOnce(
    text,
    /(path: \/data\/RUNTIME_PROFILES\s*\n\s*value: )[^\n]+/,
    "/data/RUNTIME_PROFILES",
    (_match, prefix) => `${prefix}'${JSON.stringify(next)}'`,
  );
}

/**
 * Rebuild the allowlist from the new release, keeping the file's indentation and
 * the per-entry comments that say which profile a digest belongs to. The block
 * is located by its `value:` key, and its indentation is read from the file so
 * the YAML stays as it was.
 */
function setAllowlist(text, { release, guestImage, guestDigest, profileNames, digests }) {
  const block = /([ \t]*value:\n)((?:[ \t]*#[^\n]*\n|[ \t]*- "ghcr\.io\/[^"]+"\n)+)/g;
  const matches = [...text.matchAll(block)];
  if (matches.length !== 1) {
    throw new Error(
      `could not find the guest-image allowlist (found ${matches.length} candidate blocks); ` +
        "the Kyverno policy shape changed",
    );
  }
  const indent = /^([ \t]*)/.exec(matches[0][2])[1];
  const lines = [
    `${indent}# base image, GUEST_IMAGE_DIGEST (release ${release})`,
    `${indent}- "${guestImage}@${guestDigest}"`,
  ];
  for (const name of profileNames) {
    lines.push(`${indent}# ${name} profile, RUNTIME_PROFILES.${name}.digest (${release})`);
    lines.push(`${indent}- "${guestImage}@${digests[name]}"`);
  }
  return text.replace(block, (_match, head) => `${head}${lines.join("\n")}\n`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const options = parseBumpArgs(process.argv.slice(2));
    const talos = bumpTree(options.root ?? DEFAULT_ROOT, options);
    console.log(`release pins moved to ${talos.release}`);
    console.log(`  control  ${talos.control}`);
    console.log(`  guest    ${talos.guest}  ${talos.guestDigest}`);
    for (const [name, digest] of Object.entries(talos.profiles)) {
      console.log(`  ${name.padEnd(8)} ${digest}`);
    }
    console.log("");
    console.log("Wrote deploy/talos/kustomization.yaml, deploy/release-pins.json and");
    console.log("deploy/kubernetes/kyverno/guest-image-policy.yaml.");
    console.log(`Commit them with the tag: node scripts/check-deploy-pins.mjs --tag v${talos.release}`);
  } catch (error) {
    console.error(`bump release pins: ${error.message}`);
    process.exitCode = 2;
  }
}
