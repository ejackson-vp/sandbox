import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  generateBoxKeyPair,
  generateNonce,
  openSealedJson,
  sealJsonTo,
  toBase64,
} from "../../shared/src/entries/crypto.js";
import { classifyAddress, parseCidrList } from "../../shared/src/entries/ip.js";

describe("sealed-box confidentiality", () => {
  it("round-trips a payload between independent key pairs", async () => {
    const client = await generateBoxKeyPair();
    const guest = await generateBoxKeyPair();
    const envelope = await sealJsonTo(guest.publicKey, { hello: "world", n: 42 });
    const opened = await openSealedJson<{ hello: string; n: number }>(envelope, guest.publicKey, guest.privateKey);
    expect(opened).toEqual({ hello: "world", n: 42 });

    // The client cannot open its own ciphertext (it was sealed to the guest).
    await expect(openSealedJson(envelope, client.publicKey, client.privateKey)).rejects.toThrow(/decryption failed/);
  });

  it("rejects tampered ciphertext", async () => {
    const guest = await generateBoxKeyPair();
    const envelope = await sealJsonTo(guest.publicKey, { code: "print(1)" });
    const raw = Buffer.from(envelope, "base64");
    raw[0] = (raw[0] ?? 0) ^ 0xff;
    await expect(openSealedJson(raw.toString("base64"), guest.publicKey, guest.privateKey)).rejects.toThrow(
      /decryption failed/,
    );
  });

  it("produces unique nonces", async () => {
    const a = toBase64(await generateNonce());
    const b = toBase64(await generateNonce());
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64")).toHaveLength(32);
  });
});

describe("canonical JSON", () => {
  it("is independent of key insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ z: [{ b: 1, a: 2 }], a: null })).toBe('{"a":null,"z":[{"a":2,"b":1}]}');
    expect(canonicalJson({ u: undefined, a: 1 })).toBe('{"a":1}');
  });
});

describe("address classification", () => {
  const denied = parseCidrList("10.244.0.0/16,10.96.0.0/12");

  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "metadata"],
    ["100.64.0.1", "reserved"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["198.18.0.1", "reserved"],
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["64:ff9b::7f00:1", "reserved"],
    ["2002:7f00:1::", "reserved"],
    ["1.1.1.1", "public"],
    ["8.8.8.8", "public"],
    ["2606:4700:4700::1111", "public"],
  ])("classifies %s as %s", (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  it("denies cluster CIDRs supplied by the deployment", () => {
    expect(classifyAddress("10.244.1.5", denied)).toBe("cluster");
    expect(classifyAddress("10.96.0.1", denied)).toBe("cluster");
    expect(classifyAddress("93.184.216.34", denied)).toBe("public");
  });

  it("fails closed on unparseable input", () => {
    expect(classifyAddress("not-an-ip")).toBe("reserved");
    expect(classifyAddress("")).toBe("reserved");
  });
});
