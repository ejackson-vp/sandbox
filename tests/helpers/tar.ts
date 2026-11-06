/** Minimal ustar writer for malformed-archive tests. */
import { gzipSync } from "node:zlib";

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

export function makeTar(entries: Array<{ name: string; content?: string; type?: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, 100, "utf8");
    header.write(octal(0o644, 8), 100, 8, "utf8");
    header.write(octal(0, 8), 108, 8, "utf8");
    header.write(octal(0, 8), 116, 8, "utf8");
    header.write(octal(data.length, 12), 124, 12, "utf8");
    header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, "utf8");
    header.write("        ", 148, 8, "utf8");
    header.write(entry.type ?? "0", 156, 1, "utf8");
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(octal(checksum, 8), 148, 8, "utf8");
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}
