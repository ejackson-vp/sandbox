/**
 * The deploy pin check, exercised against fixtures and against the committed
 * files.
 *
 * The regression it exists for is real: the Talos overlay shipped control
 * 0.1.30 with guest 0.1.25, both tags resolved, and the deployed pair silently
 * lacked the relay reconnect fix ADR 0012 relies on. `comparePins` is the unit
 * under test; the last case runs the committed tree so a release bump that
 * updates only one of the three files fails here as well as in CI.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDeployPins,
  comparePins,
  compareTag,
  parseArgs,
  parseKyvernoAdmitted,
  parseTalos,
  tagVersion,
} from "../../scripts/check-deploy-pins.mjs";
import { bumpReleasePins, bumpTree } from "../../scripts/bump-release-pins.mjs";

const BASE = "sha256:" + "1".repeat(64);
const PYTHON = "sha256:" + "2".repeat(64);
const NODE = "sha256:" + "3".repeat(64);
const OLD = "sha256:" + "9".repeat(64);

function pins(overrides: Record<string, unknown> = {}) {
  return {
    release: "0.1.30",
    control: "0.1.30",
    guest: "0.1.30",
    guestDigest: BASE,
    profiles: { python: PYTHON, node: NODE },
    ...overrides,
  };
}

function talosYaml(overrides: { control?: string; guest?: string; digest?: string; profiles?: string } = {}) {
  const control = overrides.control ?? "0.1.30";
  const guest = overrides.guest ?? "0.1.30";
  const digest = overrides.digest ?? BASE;
  const profiles =
    overrides.profiles ??
    `'{"python":{"image":"ghcr.io/example/guest","digest":"${PYTHON}"},"node":{"image":"ghcr.io/example/guest","digest":"${NODE}"}}'`;
  return `
images:
  - name: x402-sandbox/control
    newName: ghcr.io/example/control
    newTag: ${control}
patches:
  - target:
      kind: ConfigMap
      name: control-config
    patch: |-
      - op: replace
        path: /data/GUEST_IMAGE
        value: ghcr.io/example/guest:${guest}
      - op: replace
        path: /data/GUEST_IMAGE_DIGEST
        value: ${digest}
      - op: add
        path: /data/RUNTIME_PROFILES
        value: ${profiles}
`;
}

function kyvernoYaml(digests: string[] = [BASE, PYTHON, NODE]): string {
  return digests
    .map((digest) => `                      - "ghcr.io/example/guest@${digest}"`)
    .join("\n");
}

function drift(talos: string, admitted = kyvernoYaml()): string[] {
  return comparePins(pins(), parseTalos(talos), parseKyvernoAdmitted(admitted));
}

const NEXT = "sha256:" + "4".repeat(64);
const NEXT_PYTHON = "sha256:" + "5".repeat(64);
const NEXT_NODE = "sha256:" + "6".repeat(64);

/** Shaped like deploy/release-pins.json, comment included. */
function mapJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      _comment: ["fixture"],
      talos: {
        release: "0.1.30",
        control: "0.1.30",
        guest: "0.1.30",
        guestDigest: BASE,
        profiles: { python: PYTHON, node: NODE },
        ...overrides,
      },
    },
    null,
    2,
  );
}

/**
 * Shaped like the Kyverno policy: a `value:` list of quoted ghcr digest
 * references, each preceded by a comment, which is what the bump script
 * rewrites and what `parseKyvernoAdmitted` reads.
 */
function kyvernoPolicy(digests: string[] = [BASE, PYTHON, NODE]): string {
  const indent = "                      ";
  const entries = digests
    .map((digest, index) => `${indent}# entry ${index}\n${indent}- "ghcr.io/example/guest@${digest}"`)
    .join("\n");
  return [
    "        foreach:",
    '          - list: "request.object.spec.[containers, initContainers][]"',
    "            deny:",
    "              conditions:",
    "                any:",
    '                  - key: "{{ element.image }}"',
    "                    operator: AnyNotIn",
    "                    value:",
    entries,
    "",
  ].join("\n");
}

describe("parseTalos", () => {
  it("reads the tag pair, the digest and the profile set", () => {
    expect(parseTalos(talosYaml())).toEqual({
      controlTag: "0.1.30",
      guestImage: "ghcr.io/example/guest:0.1.30",
      guestTag: "0.1.30",
      guestDigest: BASE,
      profiles: {
        python: { image: "ghcr.io/example/guest", digest: PYTHON },
        node: { image: "ghcr.io/example/guest", digest: NODE },
      },
    });
  });

  it("throws rather than passing when a field it needs is gone", () => {
    // A regex that stops matching must be a loud failure: a check that silently
    // finds nothing would report a clean overlay for any shape at all.
    expect(() => parseTalos("images: []")).toThrow(/could not find the image tag/);
    expect(() => parseTalos(talosYaml().replace(/GUEST_IMAGE_DIGEST/, "OTHER"))).toThrow(
      /GUEST_IMAGE_DIGEST/,
    );
  });
});

describe("comparePins", () => {
  it("accepts one release pinned consistently in all three files", () => {
    expect(drift(talosYaml())).toEqual([]);
  });

  it("fails when the overlay's guest is not the one the map records", () => {
    // A lagging guest is allowed; an unrecorded one is not, because the digest
    // beside it would then belong to no release anyone can name.
    const errors = drift(talosYaml({ guest: "0.1.25" }));
    expect(errors.join("\n")).toMatch(/guest tag 0\.1\.25 does not match the release map's 0\.1\.30/);
  });

  it("fails when the guest digest is not the release's digest", () => {
    const errors = drift(talosYaml({ digest: OLD }));
    expect(errors.join("\n")).toMatch(/GUEST_IMAGE_DIGEST .* is not the 0.1.30 digest/);
  });

  it("fails when a profile digest lags, even though the base image moved", () => {
    const errors = drift(
      talosYaml({
        profiles: `'{"python":{"image":"ghcr.io/example/guest","digest":"${OLD}"},"node":{"image":"ghcr.io/example/guest","digest":"${NODE}"}}'`,
      }),
    );
    expect(errors.join("\n")).toMatch(/RUNTIME_PROFILES\.python\.digest .* is not the 0.1.30 digest/);
  });

  it("fails when the overlay drops a profile the release records", () => {
    const errors = drift(
      talosYaml({
        profiles: `'{"python":{"image":"ghcr.io/example/guest","digest":"${PYTHON}"}}'`,
      }),
    );
    expect(errors.join("\n")).toMatch(/RUNTIME_PROFILES has no node entry/);
  });

  it("fails when the map records a guest from the future", () => {
    const errors = comparePins(
      pins({ guest: "0.1.31" }) as never,
      parseTalos(talosYaml({ guest: "0.1.31" })),
      parseKyvernoAdmitted(kyvernoYaml()),
    );
    expect(errors.join("\n")).toMatch(/guest tag 0\.1\.31 is ahead of the recorded release 0\.1\.30/);
  });

  it("fails when the Kyverno allowlist was not updated with the overlay", () => {
    // The controller would be told to run one digest while admission rejects it,
    // which presents as every guest pod Pending and no obvious cause.
    const errors = drift(talosYaml(), kyvernoYaml([OLD, PYTHON, NODE]));
    expect(errors.join("\n")).toMatch(/released digest .* is not in the allowlist/);
    expect(errors.join("\n")).toMatch(/allowlist carries .* which no release map entry records/);
  });
});

describe("parseArgs", () => {
  it("takes --tag as a pair or with =, and rejects a call it cannot read", () => {
    // The release workflow passes github.ref_name here, so a typo must be a
    // usage error rather than a run that quietly checks nothing.
    expect(parseArgs(["--tag", "v0.1.31"])).toEqual({ ref: "v0.1.31" });
    expect(parseArgs(["--tag=v0.1.31"])).toEqual({ ref: "v0.1.31" });
    expect(parseArgs([])).toEqual({ ref: null });
    expect(() => parseArgs(["--tag"])).toThrow(/--tag needs a value/);
    expect(() => parseArgs(["--verbose"])).toThrow(/unknown argument/);
  });
});

describe("compareTag", () => {
  it("accepts a tag whose release the tree already pins", () => {
    expect(compareTag(pins(), parseTalos(talosYaml()), "v0.1.30")).toEqual([]);
    // The `v` is optional here so a rehearsal against a branch name cannot pass
    // by accident; a branch is not a version and must fail loudly.
    expect(tagVersion("v0.1.30")).toBe("0.1.30");
    expect(() => tagVersion("main")).toThrow(/not a version tag/);
  });

  it("catches v0.1.31 cut from a tree that still pins 0.1.30", () => {
    // The live failure this exists for: the tag, its overlay and its release map
    // were internally consistent at 0.1.30, so every committed-consistency check
    // passed and the tag deployed the previous release. Deploying by tag alone
    // ran old code until the images were overridden by hand.
    const errors = compareTag(pins(), parseTalos(talosYaml()), "v0.1.31").join("\n");
    expect(errors).toMatch(/records release 0\.1\.30, but this build is cutting 0\.1\.31/);
    expect(errors).toMatch(/control tag 0\.1\.30 is not this tag's release 0\.1\.31/);
    expect(errors).toMatch(/would deploy the 0\.1\.30 control image/);
    // The guest is allowed to lag: its digest is only knowable after the
    // release is built, so a tag necessarily names the last promoted guest.
    expect(errors).not.toMatch(/guest tag/);
  });

  it("allows the guest to lag one release, which is how a tag is cut", () => {
    const errors = compareTag(
      pins({ release: "0.1.31", control: "0.1.31" }),
      parseTalos(talosYaml({ control: "0.1.31", guest: "0.1.30" })),
      "v0.1.31",
    );
    expect(errors).toEqual([]);
  });

  it("refuses a guest from a release that cannot exist yet", () => {
    const errors = compareTag(
      pins({ release: "0.1.31", control: "0.1.31" }),
      parseTalos(talosYaml({ control: "0.1.31", guest: "0.1.32" })),
      "v0.1.31",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/guest tag 0\.1\.32 is ahead of this tag's release 0\.1\.31/);
  });
});

describe("bumpTree", () => {
  it("forwards --guest-version to the pure function", () => {
    // The wrapper is where an option gets dropped: bumpReleasePins was tested
    // with guestVersion directly, so a missing passthrough in bumpTree shipped
    // and pinned the guest to the new release instead of the promoted one.
    const root = mkdtempSync(join(tmpdir(), "pins-"));
    mkdirSync(join(root, "deploy/talos"), { recursive: true });
    mkdirSync(join(root, "deploy/kubernetes/kyverno"), { recursive: true });
    writeFileSync(join(root, "deploy/talos/kustomization.yaml"), talosYaml());
    writeFileSync(join(root, "deploy/release-pins.json"), mapJson());
    writeFileSync(
      join(root, "deploy/kubernetes/kyverno/guest-image-policy.yaml"),
      kyvernoPolicy(),
    );

    const talos = bumpTree(root, {
      version: "0.1.31",
      guestVersion: "0.1.30",
      guestDigest: NEXT,
      profileDigests: { python: NEXT_PYTHON, node: NEXT_NODE },
    });

    expect(talos.control).toBe("0.1.31");
    expect(talos.guest).toBe("0.1.30");
  });
});

describe("bumpReleasePins", () => {
  function bump(overrides: Record<string, unknown> = {}) {
    return bumpReleasePins({
      overlay: talosYaml(),
      map: mapJson(),
      kyverno: kyvernoPolicy(),
      version: "0.1.31",
      guestDigest: NEXT,
      profileDigests: { python: NEXT_PYTHON, node: NEXT_NODE },
      ...overrides,
    });
  }

  it("pins a lagging guest when --guest-version names the promoted one", () => {
    // A guest image stamps its build commit into a label, so the digest of the
    // release being cut cannot exist until after the commit that pins it. A
    // control-only release therefore names the guest that was actually
    // promoted, and the map must say so rather than claim the new release.
    const bumped = bump({ guestVersion: "0.1.30" });
    const talos = parseTalos(bumped.overlay);
    const map = JSON.parse(bumped.map).talos;

    expect(talos.controlTag).toBe("0.1.31");
    expect(talos.guestTag).toBe("0.1.30");
    expect(talos.guestDigest).toBe(NEXT);
    expect(map).toMatchObject({ release: "0.1.31", control: "0.1.31", guest: "0.1.30" });
    // Still refuses a guest from the future, which is the failure the check
    // exists for.
    expect(() => bump({ guestVersion: "0.1.32" })).toThrow(/ahead of/);
  });

  it("moves the overlay, the release map and the allowlist to one release", () => {
    const bumped = bump();
    const talos = parseTalos(bumped.overlay);
    const map = JSON.parse(bumped.map).talos;

    expect(talos.controlTag).toBe("0.1.31");
    expect(talos.guestTag).toBe("0.1.31");
    expect(talos.guestDigest).toBe(NEXT);
    expect(talos.profiles).toEqual({
      python: { image: "ghcr.io/example/guest", digest: NEXT_PYTHON },
      node: { image: "ghcr.io/example/guest", digest: NEXT_NODE },
    });
    expect(map).toMatchObject({
      release: "0.1.31",
      control: "0.1.31",
      guest: "0.1.31",
      guestDigest: NEXT,
      profiles: { python: NEXT_PYTHON, node: NEXT_NODE },
    });
    expect(parseKyvernoAdmitted(bumped.kyverno)).toEqual([NEXT, NEXT_PYTHON, NEXT_NODE]);

    // The point of the command: what it writes passes the checks a release
    // runs, including the tag check, without a second edit.
    expect(comparePins(map, talos, parseKyvernoAdmitted(bumped.kyverno))).toEqual([]);
    expect(compareTag(map, talos, "v0.1.31")).toEqual([]);
  });

  it("refuses to leave a profile at the previous release", () => {
    // A base image bumped with one profile left behind is the 0.1.30/0.1.25
    // shape again, one image at a time.
    expect(() => bump({ profileDigests: { python: NEXT_PYTHON } })).toThrow(
      /missing --profile-digest node/,
    );
  });

  it("refuses a profile the overlay does not pin, and a tag for a digest", () => {
    expect(() =>
      bump({ profileDigests: { python: NEXT_PYTHON, node: NEXT_NODE, bun: NEXT } }),
    ).toThrow(/no bun entry/);
    expect(() => bump({ guestDigest: "0.1.31" })).toThrow(/not a sha256/);
    expect(() => bump({ version: "main" })).toThrow(/not a version tag/);
  });

  it("writes nothing when the Kyverno allowlist shape changed", () => {
    // The regex that finds the allowlist is load-bearing: a silent miss would
    // leave admission rejecting every guest pod the bump just pinned.
    expect(() =>
      bump({ kyverno: "        value:\n          - \"x402-sandbox/guest@sha256:...\"\n" }),
    ).toThrow(/could not find the guest-image allowlist/);
  });
});

describe("committed deploy pins", () => {
  it("match the release map in this checkout", () => {
    expect(checkDeployPins()).toEqual([]);
  });
});
