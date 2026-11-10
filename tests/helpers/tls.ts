/**
 * Throwaway PKI for relay control mTLS tests.
 *
 * Generated at test time with the system `openssl`; nothing here is committed,
 * so the repository never carries a usable private key. A single CA signs:
 *   - the relay's server certificate (localhost/127.0.0.1 SAN),
 *   - the controller client certificate (CN=controller),
 *   - a wrong-identity client certificate (CN=api).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestPki {
  dir: string;
  caFile: string;
  serverCertFile: string;
  serverKeyFile: string;
  clientCertFile: string;
  clientKeyFile: string;
  wrongCnCertFile: string;
  wrongCnKeyFile: string;
}

function openssl(args: string[]): void {
  execFileSync("openssl", args, { stdio: "ignore" });
}

function issue(
  dir: string,
  caCert: string,
  caKey: string,
  cn: string,
  eku: "serverAuth" | "clientAuth",
  base: string,
  san?: string,
): { certFile: string; keyFile: string } {
  const keyFile = join(dir, `${base}.key`);
  const csrFile = join(dir, `${base}.csr`);
  const certFile = join(dir, `${base}.crt`);
  const extFile = join(dir, `${base}.ext`);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", csrFile, "-subj", `/CN=${cn}`]);
  writeFileSync(
    extFile,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      `extendedKeyUsage=${eku}`,
      ...(san ? [`subjectAltName=${san}`] : []),
      "",
    ].join("\n"),
  );
  openssl([
    "x509",
    "-req",
    "-in",
    csrFile,
    "-CA",
    caCert,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    certFile,
    "-days",
    "2",
    "-sha256",
    "-extfile",
    extFile,
  ]);
  return { certFile, keyFile };
}

export function makeTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "x402-relay-pki-"));
  const caKey = join(dir, "ca.key");
  const caCert = join(dir, "ca.crt");
  const caConfig = join(dir, "ca.cnf");
  writeFileSync(
    caConfig,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "x509_extensions = v3_ca",
      "[dn]",
      "CN = x402-relay-test-ca",
      "[v3_ca]",
      "basicConstraints = critical,CA:TRUE",
      "keyUsage = critical,keyCertSign,cRLSign",
      "",
    ].join("\n"),
  );
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCert,
    "-days",
    "2",
    "-sha256",
    "-config",
    caConfig,
  ]);
  const server = issue(dir, caCert, caKey, "localhost", "serverAuth", "relay", "DNS:localhost,IP:127.0.0.1");
  const client = issue(dir, caCert, caKey, "controller", "clientAuth", "controller");
  const wrongCn = issue(dir, caCert, caKey, "api", "clientAuth", "wrong-cn");

  return {
    dir,
    caFile: caCert,
    serverCertFile: server.certFile,
    serverKeyFile: server.keyFile,
    clientCertFile: client.certFile,
    clientKeyFile: client.keyFile,
    wrongCnCertFile: wrongCn.certFile,
    wrongCnKeyFile: wrongCn.keyFile,
  };
}
