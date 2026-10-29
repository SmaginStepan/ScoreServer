import { X509Certificate, verify as verifySignature } from "node:crypto";

// App Store purchases arrive as StoreKit 2 signed transactions: a JWS
// whose header carries the signing chain (leaf, intermediate, Apple's
// root). Checking it needs no Apple credentials, only the root's
// fingerprint: the chain must end at Apple Root CA - G3, every link must
// sign the next, both lower certificates must carry Apple's App Store
// markers, and the leaf must have signed the transaction.

// Apple Root CA - G3 (https://www.apple.com/certificateauthority/).
export const APPLE_ROOT_G3_SHA256 =
  "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79";

// DER-encoded marker extensions: 1.2.840.113635.100.6.11.1 on the leaf,
// 1.2.840.113635.100.6.2.1 on the intermediate.
const LEAF_MARKER = Buffer.from("060a2a864886f76364060b01", "hex");
const INTERMEDIATE_MARKER = Buffer.from("060a2a864886f76364060201", "hex");

export interface AppleTransaction {
  transactionId: string;
  originalTransactionId?: string;
  bundleId: string;
  productId: string;
  type?: string;
  environment?: string;
  signedDate?: number;
  revocationDate?: number;
}

export type AppleCheck =
  | { valid: true; transaction: AppleTransaction }
  | { valid: false; reason: string };

export function verifyAppleTransaction(
  jws: string,
  rootFingerprint: string = APPLE_ROOT_G3_SHA256,
): AppleCheck {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    return invalid("not a signed transaction");
  }

  let header: { alg?: string; x5c?: string[] };
  let transaction: AppleTransaction;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    transaction = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return invalid("unreadable signed transaction");
  }

  if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3) {
    return invalid("unexpected signature header");
  }

  let chain: X509Certificate[];
  try {
    chain = header.x5c.map((cert) => new X509Certificate(Buffer.from(cert, "base64")));
  } catch {
    return invalid("unreadable certificate chain");
  }

  const [leaf, intermediate, root] = chain;
  if (root.fingerprint256 !== rootFingerprint) {
    return invalid("chain does not end at Apple's root");
  }

  if (!root.verify(root.publicKey) || !intermediate.verify(root.publicKey) || !leaf.verify(intermediate.publicKey)) {
    return invalid("broken certificate chain");
  }

  if (!leaf.raw.includes(LEAF_MARKER) || !intermediate.raw.includes(INTERMEDIATE_MARKER)) {
    return invalid("not an App Store signing certificate");
  }

  const signedAt = transaction.signedDate ?? Date.now();
  for (const cert of [leaf, intermediate]) {
    if (signedAt < Date.parse(cert.validFrom) || signedAt > Date.parse(cert.validTo)) {
      return invalid("certificate not valid when the transaction was signed");
    }
  }

  const signed = verifySignature(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url"),
  );
  if (!signed) {
    return invalid("bad signature");
  }

  if (!transaction.transactionId || !transaction.bundleId || !transaction.productId) {
    return invalid("incomplete transaction");
  }

  return { valid: true, transaction };
}

function invalid(reason: string): AppleCheck {
  return { valid: false, reason };
}
