#!/usr/bin/env node
/**
 * The Talos overlay must deploy one release, and the guest must be pinned to the
 * digest of that release.
 *
 * Why this exists: `deploy/talos/kustomization.yaml` pinned the control image at
 * 0.1.30 and the guest image at 0.1.25. Both are valid tags, both resolve, and
 * nothing failed until someone noticed the guest did not contain the relay
 * reconnect fix ADR 0012 relies on. A tag pair is not a release pair.
 *
 * Offline and deterministic on purpose: CI has no registry credentials for the
 * digests and a registry answer is not reproducible anyway. The link between a
 * tag and a digest is `deploy/release-pins.json`, committed in the same change
 * as the overlay. This check compares the overlay, the map and the Kyverno
 * allowlist, so the only way to move one is to move all three.
 *
 * With `--tag vX.Y.Z` it also checks the thing a committed-consistency check
 * cannot see: that the release being cut is the release this tree pins. A tag
 * deploys the overlay in its own commit, so v0.1.31 cut from a tree whose
 * overlay still said 0.1.30 deployed 0.1.30 images, with nothing failing. The
 * release workflow passes `github.ref_name`; `compareTag` is the unit under
 * test.
 *
 * No YAML parser: the file shapes are fixed and pinned by this script, so a
 * regex that stops matching is a loud failure rather than a silent pass. The
 * extractors below throw when they cannot find a field.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const FILES = {
  pins: "deploy/release-pins.json",
  talos: "deploy/talos/kustomization.yaml",
  kyverno: "deploy/kubernetes/kyverno/guest-image-policy.yaml",
};

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TAG = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The fields this check reasons about, read out of one overlay. */
export function parseTalos(text) {
  const controlTag = imageTag(text, "x402-sandbox/control");
  const guestImage = configValue(text, "GUEST_IMAGE");
  const guestDigest = configValue(text, "GUEST_IMAGE_DIGEST");
  const profiles = JSON.parse(unquote(configValue(text, "RUNTIME_PROFILES")));
  return {
    controlTag,
    guestImage,
    guestTag: tagOf(guestImage),
    guestDigest,
    profiles,
  };
}

/** The digests the Kyverno policy admits, as a set. */
export function parseKyvernoAdmitted(text) {
  const found = [...text.matchAll(/^\s*-\s*"(ghcr\.io\/[^"]+@(sha256:[0-9a-f]{64}))"\s*$/gm)];
  return found.map((match) => match[2]);
}

/** Problems, each naming the file and what disagrees. Empty means consistent. */
export function comparePins(pins, talos, admitted) {
  const errors = [];
  const say = (message) => errors.push(message);

  if (pins.control !== pins.release) {
    say(`release map: control tag ${pins.control} is not the recorded release ${pins.release}`);
  }
  if (pins.guest !== pins.release) {
    say(`release map: guest tag ${pins.guest} is not the recorded release ${pins.release}`);
  }
  for (const [name, tag] of Object.entries({ control: pins.control, guest: pins.guest })) {
    if (!TAG.test(String(tag))) {
      say(`release map: ${name} tag ${tag} is not a version tag`);
    }
  }
  if (!DIGEST.test(String(pins.guestDigest))) {
    say(`release map: guestDigest ${pins.guestDigest} is not a sha256 digest`);
  }

  // The two images in one overlay must come from one release. This is the check
  // that would have caught 0.1.30 control + 0.1.25 guest.
  if (talos.controlTag !== talos.guestTag) {
    say(
      `deploy/talos: control tag ${talos.controlTag} and guest tag ${talos.guestTag} ` +
        `are different releases; deploy one pair`,
    );
  }
  if (talos.controlTag !== pins.control) {
    say(
      `deploy/talos: control tag ${talos.controlTag} does not match the release map's ` +
        `${pins.control}`,
    );
  }
  if (talos.guestTag !== pins.guest) {
    say(
      `deploy/talos: guest tag ${talos.guestTag} does not match the release map's ${pins.guest}`,
    );
  }
  if (talos.guestDigest !== pins.guestDigest) {
    say(
      `deploy/talos: GUEST_IMAGE_DIGEST ${talos.guestDigest} is not the ${pins.release} ` +
        `digest ${pins.guestDigest}; a digest is the only part of this pin that cannot move`,
    );
  }

  for (const [name, digest] of Object.entries(pins.profiles)) {
    const deployed = talos.profiles?.[name]?.digest;
    if (!deployed) {
      say(`deploy/talos: RUNTIME_PROFILES has no ${name} entry; the release map records one`);
      continue;
    }
    if (deployed !== digest) {
      say(
        `deploy/talos: RUNTIME_PROFILES.${name}.digest ${deployed} is not the ${pins.release} ` +
          `digest ${digest}`,
      );
    }
  }
  for (const name of Object.keys(talos.profiles ?? {})) {
    if (!(name in pins.profiles)) {
      say(
        `deploy/talos: RUNTIME_PROFILES names profile ${name}, which the release map does ` +
          `not record for ${pins.release}`,
      );
    }
  }

  // The Kyverno allowlist is the second, independent copy of the same digests.
  // If it is not updated with the overlay, admission control rejects the very
  // pods the controller is told to run.
  const expected = new Set([pins.guestDigest, ...Object.values(pins.profiles)]);
  const actual = new Set(admitted);
  for (const digest of expected) {
    if (!actual.has(digest)) {
      say(`${FILES.kyverno}: released digest ${digest} is not in the allowlist`);
    }
  }
  for (const digest of actual) {
    if (!expected.has(digest)) {
      say(`${FILES.kyverno}: allowlist carries ${digest}, which no release map entry records`);
    }
  }
  return errors;
}

/** `v0.1.31` -> `0.1.31`. Image tags never carry the `v`, the git tag always does. */
export function tagVersion(ref) {
  const value = String(ref ?? "").trim();
  const version = value.startsWith("v") ? value.slice(1) : value;
  if (!TAG.test(version)) {
    throw new Error(`"${value}" is not a version tag; expected vX.Y.Z, for example v0.1.31`);
  }
  return version;
}

/**
 * The overlay and the map must name the release this build is cutting.
 *
 * `comparePins` proves the three files agree with each other; it cannot prove
 * they agree with the tag, because the tag is not one of the files. That gap is
 * exactly v0.1.31: overlay, map and allowlist were internally consistent at
 * 0.1.30, and the tag was cut as 0.1.31, so the tag deployed the previous
 * release. The digest check needs no registry lookup here: the digest is tied
 * to the map (`comparePins`) and the map is tied to the tag (this function).
 *
 * Takes the parsed overlay and the tag, so it is checkable without a checkout.
 */
export function compareTag(pins, talos, ref) {
  const version = tagVersion(ref);
  const errors = [];
  const say = (message) => errors.push(message);

  if (pins.release !== version) {
    say(
      `release map: records release ${pins.release}, but this build is cutting ${version} ` +
        `(${ref}); the tag would deploy the ${pins.release} release`,
    );
  }
  // The two images are named separately rather than trusting the map: a tag
  // whose overlay names one stale image is the failure being prevented, and the
  // message should say which one so the fix is obvious.
  if (talos.controlTag !== version) {
    say(
      `deploy/talos: control tag ${talos.controlTag} is not this tag's release ${version}; ` +
        `${ref} would deploy the ${talos.controlTag} control image`,
    );
  }
  if (talos.guestTag !== version) {
    say(
      `deploy/talos: guest tag ${talos.guestTag} is not this tag's release ${version}; ` +
        `${ref} would deploy the ${talos.guestTag} guest image`,
    );
  }
  return errors;
}

export function checkDeployPins(root = DEFAULT_ROOT, ref = null) {
  const pins = JSON.parse(readFileSync(join(root, FILES.pins), "utf8")).talos;
  const talos = parseTalos(readFileSync(join(root, FILES.talos), "utf8"));
  const admitted = parseKyvernoAdmitted(readFileSync(join(root, FILES.kyverno), "utf8"));
  const errors = comparePins(pins, talos, admitted);
  if (ref) errors.push(...compareTag(pins, talos, ref));
  return errors;
}

function imageTag(text, imageName) {
  const match = new RegExp(
    `- name: ${escapeRegExp(imageName)}\\s*\\n\\s*newName: [^\\n]+\\n\\s*newTag: (\\S+)`,
  ).exec(text);
  if (!match) throw new Error(`could not find the image tag for ${imageName} in ${FILES.talos}`);
  return match[1];
}

function configValue(text, key) {
  const match = new RegExp(
    `path: /data/${escapeRegExp(key)}\\s*\\n\\s*value: (.*)`,
  ).exec(text);
  if (!match) throw new Error(`could not find /data/${key} in ${FILES.talos}`);
  return match[1].trim();
}

function tagOf(image) {
  const at = image.lastIndexOf(":");
  const slash = image.lastIndexOf("/");
  if (at <= slash) throw new Error(`image ${image} has no tag; the overlay must pin one`);
  return image.slice(at + 1);
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const USAGE = "usage: node scripts/check-deploy-pins.mjs [--tag vX.Y.Z]";

/** `--tag v0.1.31` or `--tag=v0.1.31`; anything else is a usage error. */
export function parseArgs(argv) {
  let ref = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`--tag needs a value\n${USAGE}`);
      ref = value;
      index += 1;
    } else if (arg.startsWith("--tag=")) {
      ref = arg.slice("--tag=".length);
      if (!ref) throw new Error(`--tag needs a value\n${USAGE}`);
    } else {
      throw new Error(`unknown argument ${arg}\n${USAGE}`);
    }
  }
  return { ref };
}

const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let errors;
  let ref = null;
  try {
    ({ ref } = parseArgs(process.argv.slice(2)));
    errors = checkDeployPins(DEFAULT_ROOT, ref);
  } catch (error) {
    console.error(`deploy pins: ${error.message}`);
    process.exitCode = 2;
  }
  if (errors) {
    if (errors.length > 0) {
      console.error("deploy pins drifted:");
      for (const error of errors) console.error(`  - ${error}`);
      console.error("");
      console.error(
        "Update deploy/talos/kustomization.yaml, deploy/release-pins.json and the allowlist " +
          "in deploy/kubernetes/kyverno/guest-image-policy.yaml together, from one release, " +
          "with `npm run release:bump-pins`. A tag deploys the pins in its own tree, so they " +
          "must name the release the tag claims.",
      );
      process.exitCode = 1;
    } else {
      const pins = JSON.parse(readFileSync(join(DEFAULT_ROOT, FILES.pins), "utf8")).talos;
      const against = ref ? ` and match tag ${ref}` : "";
      console.log(
        `deploy pins ok: Talos overlay, Kyverno allowlist and release map match release ` +
          `${pins.release}${against}`,
      );
    }
  }
}
