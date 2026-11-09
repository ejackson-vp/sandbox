/**
 * IP address classification for the egress proxy.
 *
 * The proxy never trusts a hostname for a security decision: it resolves the
 * name itself, validates *every* returned address, then connects to the exact
 * validated IP literal. That removes DNS rebinding and TOCTOU windows.
 */

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "metadata"
  | "cluster"
  | "reserved"
  | "multicast"
  | "unspecified";

const CIDR_V4: Array<{ cidr: string; cls: AddressClass }> = [
  { cidr: "0.0.0.0/8", cls: "reserved" },
  { cidr: "10.0.0.0/8", cls: "private" },
  { cidr: "100.64.0.0/10", cls: "reserved" }, // CGNAT
  { cidr: "127.0.0.0/8", cls: "loopback" },
  // Metadata endpoints must be classified before the broader link-local range.
  { cidr: "169.254.169.254/32", cls: "metadata" },
  { cidr: "169.254.170.2/32", cls: "metadata" }, // ECS task metadata
  { cidr: "169.254.0.0/16", cls: "link-local" },
  { cidr: "172.16.0.0/12", cls: "private" },
  { cidr: "192.0.0.0/24", cls: "reserved" },
  { cidr: "192.0.2.0/24", cls: "reserved" },
  { cidr: "192.168.0.0/16", cls: "private" },
  { cidr: "198.18.0.0/15", cls: "reserved" }, // benchmarking
  { cidr: "198.51.100.0/24", cls: "reserved" },
  { cidr: "203.0.113.0/24", cls: "reserved" },
  { cidr: "224.0.0.0/4", cls: "multicast" },
  { cidr: "240.0.0.0/4", cls: "reserved" },
  { cidr: "255.255.255.255/32", cls: "reserved" },
];

const CIDR_V6: Array<{ cidr: string; cls: AddressClass }> = [
  { cidr: "::/128", cls: "unspecified" },
  { cidr: "::1/128", cls: "loopback" },
  { cidr: "::ffff:0:0/96", cls: "reserved" }, // IPv4-mapped, handled separately
  { cidr: "64:ff9b::/96", cls: "reserved" }, // NAT64
  { cidr: "64:ff9b:1::/48", cls: "reserved" },
  { cidr: "100::/64", cls: "reserved" }, // discard-only
  { cidr: "2001::/32", cls: "reserved" }, // Teredo
  { cidr: "2001:db8::/32", cls: "reserved" },
  { cidr: "2002::/16", cls: "reserved" }, // 6to4
  { cidr: "fc00::/7", cls: "private" }, // ULA
  { cidr: "fe80::/10", cls: "link-local" },
  { cidr: "fec0::/10", cls: "reserved" },
  { cidr: "ff00::/8", cls: "multicast" },
];

function parseV4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/** Expand an IPv6 literal into 16 bytes. Supports `::` compression. */
export function parseV6(ip: string): Uint8Array | null {
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip.includes(":")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  const expand = (groups: string[]): number[] | null => {
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (g.includes(".")) {
        // Embedded IPv4 (only valid as the last 32 bits)
        const v4 = parseV4(g);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const h = expand(head);
  const t = expand(tail);
  if (!h || !t) return null;
  if (halves.length === 1) {
    if (h.length !== 8) return null;
  } else if (h.length + t.length > 7) {
    return null;
  }
  const groups = [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = (g >> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  });
  return bytes;
}

function cidrMatchV4(value: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const baseNum = parseV4(base!);
  if (baseNum === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseNum & mask);
}

function cidrMatchV6(bytes: Uint8Array, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const baseBytes = parseV6(base!);
  if (!baseBytes) return false;
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== baseBytes[i]) return false;
  }
  const rem = bits % 8;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (bytes[fullBytes]! & mask) === (baseBytes[fullBytes]! & mask);
}

/**
 * Classify an address. Unparseable input is "reserved" (i.e. denied).
 * `extraDeniedCidrs` lets the deployment block its own cluster CIDRs.
 */
export function classifyAddress(ip: string, extraDeniedCidrs: string[] = []): AddressClass {
  const v4 = parseV4(ip);
  if (v4 !== null) {
    if (v4 === 0) return "unspecified";
    // Deployment-supplied cluster CIDRs are labelled distinctly so operators see
    // why a destination was denied.
    for (const cidr of extraDeniedCidrs) {
      if (cidrMatchV4(v4, cidr)) return "cluster";
    }
    for (const { cidr, cls } of CIDR_V4) {
      if (cidrMatchV4(v4, cidr)) return cls;
    }
    return "public";
  }

  const v6 = parseV6(ip);
  if (!v6) return "reserved";

  // IPv4-mapped: classify by the embedded IPv4 address (defeats ::ffff:127.0.0.1 tricks).
  const isMapped =
    v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  if (isMapped) {
    const embedded = `${v6[12]}.${v6[13]}.${v6[14]}.${v6[15]}`;
    return classifyAddress(embedded, extraDeniedCidrs);
  }
  // Exact :: and ::1 before the deprecated IPv4-compatible form.
  if (v6.every((b) => b === 0)) return "unspecified";
  if (v6.slice(0, 15).every((b) => b === 0) && v6[15] === 1) return "loopback";

  // IPv4-compatible form (deprecated) e.g. ::127.0.0.1
  const isCompat = v6.slice(0, 12).every((b) => b === 0);
  if (isCompat) {
    const embedded = `${v6[12]}.${v6[13]}.${v6[14]}.${v6[15]}`;
    return classifyAddress(embedded, extraDeniedCidrs);
  }

  for (const cidr of extraDeniedCidrs) {
    if (cidrMatchV6(v6, cidr)) return "cluster";
  }
  for (const { cidr, cls } of CIDR_V6) {
    if (cidrMatchV6(v6, cidr)) return cls;
  }
  return "public";
}

/** Parse a comma-separated CIDR list from configuration. */
export function parseCidrList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
