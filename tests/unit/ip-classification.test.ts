/**
 * The egress proxy denies anything `classifyAddress` does not call `public`, and
 * the class it returns is the text an operator sees in
 * `blocked_destination:<class>` and in the metrics label. So every row here
 * asserts the class and the resulting deny decision, not just "not public".
 *
 * The CIDR tables are duplicated from `shared/src/ip.ts` on purpose: an
 * independent oracle is the only thing that can fail when a range is moved or
 * reclassified. One test reads the source and fails if the two ever drift.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyAddress,
  parseCidrList,
  parseV6,
  type AddressClass,
} from "../../shared/src/entries/ip.js";

/** What the proxy does with a class: deny it, and label the denial. */
function decision(cls: AddressClass): { denied: boolean; reason: string } {
  return { denied: cls !== "public", reason: `blocked_destination:${cls}` };
}

type Row = {
  cidr: string;
  cls: AddressClass;
  /** Set where a rule earlier in `classifyAddress` wins at the boundary. */
  first?: AddressClass;
  last?: AddressClass;
};

const CIDR_V4_ROWS: Row[] = [
  // 0.0.0.0 is special-cased to `unspecified` before the 0.0.0.0/8 rule runs.
  { cidr: "0.0.0.0/8", cls: "reserved", first: "unspecified" },
  { cidr: "10.0.0.0/8", cls: "private" },
  { cidr: "100.64.0.0/10", cls: "reserved" }, // CGNAT
  { cidr: "127.0.0.0/8", cls: "loopback" },
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

const CIDR_V6_ROWS: Row[] = [
  { cidr: "::/128", cls: "unspecified" },
  { cidr: "::1/128", cls: "loopback" },
  // The first address is IPv4-mapped 0.0.0.0, which classifies as unspecified.
  { cidr: "::ffff:0:0/96", cls: "reserved", first: "unspecified" },
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

function v4ToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function numberToV4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

/** First and last address of a v4 CIDR, dotted. */
function v4Boundaries(cidr: string): [string, string] {
  const [base = "", bitsRaw = "32"] = cidr.split("/");
  const bits = Number(bitsRaw);
  const first = v4ToNumber(base);
  const hostBits = 32 - bits;
  const last = hostBits === 32 ? 0xffffffff : (first | (2 ** hostBits - 1)) >>> 0;
  return [numberToV4(first), numberToV4(last)];
}

function formatV6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return groups.join(":");
}

/** First and last address of a v6 CIDR, written out with no `::` compression. */
function v6Boundaries(cidr: string): [string, string] {
  const [base = "", bitsRaw = "128"] = cidr.split("/");
  const bits = Number(bitsRaw);
  const parsed = parseV6(base);
  if (!parsed) throw new Error(`test helper cannot parse ${base}`);
  const full = Math.floor(bits / 8);
  const rem = bits % 8;
  const last = Uint8Array.from(parsed);
  if (rem !== 0) last[full]! |= 0xff >> rem;
  for (let i = rem === 0 ? full : full + 1; i < 16; i++) last[i] = 0xff;
  return [formatV6(parsed), formatV6(last)];
}

describe("every CIDR in the v4 table", () => {
  it.each(CIDR_V4_ROWS)("$cidr classifies both boundaries as $cls", (row) => {
    const [first, last] = v4Boundaries(row.cidr);
    const firstExpected = row.first ?? row.cls;
    const lastExpected = row.last ?? row.cls;
    expect(classifyAddress(first), first).toBe(firstExpected);
    expect(classifyAddress(last), last).toBe(lastExpected);
    expect(decision(firstExpected).denied).toBe(firstExpected !== "public");
    expect(decision(lastExpected).denied).toBe(lastExpected !== "public");
  });
});

describe("every CIDR in the v6 table", () => {
  it.each(CIDR_V6_ROWS)("$cidr classifies both boundaries as $cls", (row) => {
    const [first, last] = v6Boundaries(row.cidr);
    const firstExpected = row.first ?? row.cls;
    const lastExpected = row.last ?? row.cls;
    expect(classifyAddress(first), first).toBe(firstExpected);
    expect(classifyAddress(last), last).toBe(lastExpected);
    expect(decision(firstExpected).denied).toBe(firstExpected !== "public");
    expect(decision(lastExpected).denied).toBe(lastExpected !== "public");
  });
});

describe("the test table matches the production table", () => {
  it("lists exactly the CIDRs and classes in shared/src/ip.ts", () => {
    const source = readFileSync(new URL("../../shared/src/ip.ts", import.meta.url), "utf8");
    const declared = [...source.matchAll(/\{ cidr: "([^"]+)", cls: "([^"]+)" \}/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    const expected = [...CIDR_V4_ROWS, ...CIDR_V6_ROWS].map((row) => `${row.cidr} ${row.cls}`);
    expect(declared.sort()).toEqual(expected.sort());
  });
});

describe("addresses between the ranges are public", () => {
  it.each([
    "1.0.0.1",
    "9.255.255.255",
    "11.0.0.1",
    "100.128.0.1", // one past CGNAT
    "169.253.255.255",
    "169.255.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.167.255.255",
    "192.169.0.1",
    "198.20.0.1", // one past the benchmarking range
    "223.255.255.255",
    "8.8.8.8",
    "93.184.216.34",
    "1.1.1.1",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "fe00::1", // below fe80::/10
    "2a00:1450:4001:81b::200e",
  ])("classifies %s as public and allows it", (ip) => {
    const cls = classifyAddress(ip);
    expect(cls).toBe("public");
    expect(decision(cls)).toEqual({ denied: false, reason: "blocked_destination:public" });
  });
});

describe("precedence inside classifyAddress", () => {
  it("classifies metadata before the wider link-local range", () => {
    expect(classifyAddress("169.254.169.254")).toBe("metadata");
    expect(classifyAddress("169.254.169.253")).toBe("link-local");
    expect(classifyAddress("169.254.169.255")).toBe("link-local");
    expect(classifyAddress("169.254.170.2")).toBe("metadata");
    expect(classifyAddress("169.254.170.1")).toBe("link-local");
    expect(classifyAddress("169.254.170.3")).toBe("link-local");
    expect(classifyAddress("169.254.0.1")).toBe("link-local");
  });

  it("classifies exact :: and ::1 before the deprecated IPv4-compatible form", () => {
    // ::0.0.0.1 is the same 128 bits as ::1. Through the compatible path it
    // would be 0.0.0.1 and land in 0.0.0.0/8, so loopback is the only answer
    // that proves the exact :: and ::1 rules run first.
    expect(classifyAddress("::")).toBe("unspecified");
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("::0.0.0.1")).toBe("loopback");
    expect(classifyAddress("::0.0.0.0")).toBe("unspecified");
    expect(classifyAddress("::0.0.0.2")).toBe("reserved");
    expect(classifyAddress("::127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::10.0.0.1")).toBe("private");
    expect(classifyAddress("::169.254.169.254")).toBe("metadata");
    expect(classifyAddress("::8.8.8.8")).toBe("public");
  });

  it("classifies IPv4-mapped addresses by the embedded IPv4 address", () => {
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::ffff:10.0.0.1")).toBe("private");
    expect(classifyAddress("::ffff:192.168.1.1")).toBe("private");
    expect(classifyAddress("::ffff:169.254.169.254")).toBe("metadata");
    expect(classifyAddress("::ffff:0.0.0.0")).toBe("unspecified");
    expect(classifyAddress("::ffff:255.255.255.255")).toBe("reserved");
    expect(classifyAddress("::ffff:224.0.0.1")).toBe("multicast");
    expect(classifyAddress("::ffff:8.8.8.8")).toBe("public");
    // Hex form of the same bytes: 127.0.0.1 is 7f00:1.
    expect(classifyAddress("::ffff:7f00:1")).toBe("loopback");
    expect(classifyAddress("::FFFF:7F00:0001")).toBe("loopback");
  });

  it("keeps NAT64, 6to4 and Teredo reserved even when they embed a private v4", () => {
    expect(classifyAddress("64:ff9b::a00:1")).toBe("reserved"); // 10.0.0.1
    expect(classifyAddress("64:ff9b::7f00:1")).toBe("reserved"); // 127.0.0.1
    expect(classifyAddress("64:ff9b:1::a00:1")).toBe("reserved");
    expect(classifyAddress("2002:a00:1::")).toBe("reserved"); // 6to4, 10.0.0.1
    expect(classifyAddress("2002:7f00:1::")).toBe("reserved"); // 6to4, 127.0.0.1
    expect(classifyAddress("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe("reserved"); // Teredo
  });
});

describe("zone ids and letter case", () => {
  it.each([
    ["fe80::1%eth0", "link-local"],
    ["fe80::1%en0", "link-local"],
    ["::1%lo0", "loopback"],
    ["2001:db8::1%eth0.100", "reserved"],
    ["FE80::1", "link-local"],
    ["FC00::1", "private"],
    ["2001:DB8::1", "reserved"],
    ["0.0.0.0", "unspecified"],
  ])("classifies %s as %s", (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected as AddressClass);
  });
});

describe("malformed input fails closed", () => {
  it.each([
    "",
    " ",
    "not-an-ip",
    "localhost",
    "1.2.3",
    "1.2.3.4.5",
    "1.2.3.256",
    "256.1.2.3",
    "1.2.3.a",
    "1.2.3.4a",
    "1..2.3",
    ".1.2.3",
    "1.2.3.",
    " 8.8.8.8",
    "8.8.8.8 ",
    "-1.2.3.4",
    ":",
    ":::",
    "1:2:3",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7:8::",
    "12345::",
    "::gggg",
    "1::2::3",
    "::ffff:1.2.3",
    "::ffff:1.2.3.4.5",
    "::ffff:256.1.1.1",
  ])("classifies %j as reserved and denies it", (ip) => {
    expect(classifyAddress(ip)).toBe("reserved");
    expect(decision("reserved")).toEqual({ denied: true, reason: "blocked_destination:reserved" });
    expect(parseV6(ip)).toBeNull();
  });
});

describe("parseV6", () => {
  it("expands compressed forms to 16 bytes", () => {
    expect(parseV6("::")).toEqual(new Uint8Array(16));
    expect(Array.from(parseV6("::1")!)).toEqual([...new Array(15).fill(0), 1]);
    expect(Array.from(parseV6("2001:db8::1")!)).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01,
    ]);
    expect(Array.from(parseV6("::1:2:3")!)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 3,
    ]);
  });

  it("accepts an embedded IPv4 address only in the last 32 bits", () => {
    expect(Array.from(parseV6("::ffff:1.2.3.4")!)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2, 3, 4,
    ]);
    // In a non-final position the embedded v4 parses but is not treated as
    // mapped, so the address falls through to the tables as an ordinary network
    // address and lands outside every reserved range.
    expect(classifyAddress("1.2.3.4::")).toBe("public");
  });

  it("rejects a non-IPv6 string", () => {
    expect(parseV6("8.8.8.8")).toBeNull();
    expect(parseV6("")).toBeNull();
  });
});

describe("deployment-supplied cluster CIDRs", () => {
  const denied = parseCidrList("10.244.0.0/16,10.96.0.0/12");

  it("labels a match cluster rather than private so the denial is diagnosable", () => {
    expect(classifyAddress("10.244.1.5", denied)).toBe("cluster");
    expect(classifyAddress("10.96.0.1", denied)).toBe("cluster");
    expect(classifyAddress("10.244.0.0", denied)).toBe("cluster");
    expect(classifyAddress("10.244.255.255", denied)).toBe("cluster");
    // Same address without the deployment list keeps the generic label.
    expect(classifyAddress("10.244.1.5")).toBe("private");
    // Adjacent, but outside both ranges.
    expect(classifyAddress("10.245.0.1", denied)).toBe("private");
    expect(classifyAddress("10.112.0.1", denied)).toBe("private");
  });

  it("does not touch public addresses", () => {
    expect(classifyAddress("93.184.216.34", denied)).toBe("public");
    expect(classifyAddress("2606:4700:4700::1111", denied)).toBe("public");
  });

  it("applies to IPv4-mapped and IPv4-compatible forms", () => {
    expect(classifyAddress("::ffff:10.244.1.5", denied)).toBe("cluster");
    expect(classifyAddress("::10.244.1.5", denied)).toBe("cluster");
    expect(classifyAddress("::ffff:10.245.0.1", denied)).toBe("private");
  });

  it("matches v6 cluster CIDRs", () => {
    expect(classifyAddress("fd00::1", ["fd00::/64"])).toBe("cluster");
    expect(classifyAddress("fd00:0:0:0:ffff::2", ["fd00::/64"])).toBe("cluster");
    expect(classifyAddress("fd00::1")).toBe("private");
    expect(classifyAddress("fd00:0:0:1::1", ["fd00::/64"])).toBe("private");
  });

  it("a zero-bit CIDR matches every address of its family", () => {
    expect(classifyAddress("8.8.8.8", ["0.0.0.0/0"])).toBe("cluster");
    expect(classifyAddress("2606:4700:4700::1111", ["0.0.0.0/0"])).toBe("public");
    expect(classifyAddress("2606:4700:4700::1111", ["::/0"])).toBe("cluster");
  });

  it("ignores entries that are not parseable CIDRs", () => {
    expect(classifyAddress("8.8.8.8", ["nonsense"])).toBe("public");
    expect(classifyAddress("2606:4700:4700::1111", ["::zz/8"])).toBe("public");
    expect(classifyAddress("8.8.8.8", ["::zz/8"])).toBe("public");
  });
});

describe("parseCidrList", () => {
  it("returns an empty list for absent or blank configuration", () => {
    expect(parseCidrList(undefined)).toEqual([]);
    expect(parseCidrList("")).toEqual([]);
    expect(parseCidrList("   ")).toEqual([]);
    expect(parseCidrList(",,")).toEqual([]);
  });

  it("splits, trims and drops empty entries", () => {
    expect(parseCidrList("10.244.0.0/16, 10.96.0.0/12")).toEqual(["10.244.0.0/16", "10.96.0.0/12"]);
    expect(parseCidrList(" 10.244.0.0/16 ,, fd00::/8 ,")).toEqual(["10.244.0.0/16", "fd00::/8"]);
  });
});

describe("the deny decision and its label", () => {
  const sample: Array<[string, AddressClass, string[]?]> = [
    ["93.184.216.34", "public"],
    ["127.0.0.1", "loopback"],
    ["10.0.0.1", "private"],
    ["169.254.1.1", "link-local"],
    ["169.254.169.254", "metadata"],
    ["10.244.1.5", "cluster", ["10.244.0.0/16"]],
    ["192.0.2.1", "reserved"],
    ["224.0.0.1", "multicast"],
    ["0.0.0.0", "unspecified"],
  ];

  it.each(sample)("denies %s as %s", (ip, expected, extra) => {
    const cls = classifyAddress(ip, extra);
    expect(cls).toBe(expected);
    expect(decision(cls)).toEqual({
      denied: expected !== "public",
      reason: `blocked_destination:${expected}`,
    });
  });

  it("allows only public and denies every other label", () => {
    const denied: AddressClass[] = [
      "loopback",
      "private",
      "link-local",
      "metadata",
      "cluster",
      "reserved",
      "multicast",
      "unspecified",
    ];
    for (const cls of denied) expect(decision(cls).denied, cls).toBe(true);
    expect(decision("public").denied).toBe(false);
  });
});
