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
import { describe, expect, it } from "vitest";
import {
  checkDeployPins,
  comparePins,
  parseKyvernoAdmitted,
  parseTalos,
} from "../../scripts/check-deploy-pins.mjs";

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

  it("fails when control and guest come from different releases", () => {
    const errors = drift(talosYaml({ guest: "0.1.25" }));
    expect(errors.join("\n")).toMatch(/control tag 0.1.30 and guest tag 0.1.25 are different releases/);
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

  it("fails when the map disagrees with itself", () => {
    const errors = comparePins(
      pins({ guest: "0.1.29" }) as never,
      parseTalos(talosYaml({ guest: "0.1.29" })),
      parseKyvernoAdmitted(kyvernoYaml()),
    );
    expect(errors.join("\n")).toMatch(/guest tag 0.1.29 is not the recorded release 0.1.30/);
  });

  it("fails when the Kyverno allowlist was not updated with the overlay", () => {
    // The controller would be told to run one digest while admission rejects it,
    // which presents as every guest pod Pending and no obvious cause.
    const errors = drift(talosYaml(), kyvernoYaml([OLD, PYTHON, NODE]));
    expect(errors.join("\n")).toMatch(/released digest .* is not in the allowlist/);
    expect(errors.join("\n")).toMatch(/allowlist carries .* which no release map entry records/);
  });
});

describe("committed deploy pins", () => {
  it("match the release map in this checkout", () => {
    expect(checkDeployPins()).toEqual([]);
  });
});
