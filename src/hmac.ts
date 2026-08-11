import { createHmac, createHash, timingSafeEqual } from "node:crypto";

// Writes are signed: sig = HMAC-SHA256(secret, "{ts}\n{method}\n{path}\n{sha256hex(body)}").
// The window is generous (mobile clocks drift); replays inside the
// window land in the audit table where the min-interval rule and the
// best-score-only upsert make them harmless.
export const SIGNATURE_WINDOW_S = 300;

export function signaturePayload(
  ts: string,
  method: string,
  path: string,
  body: Buffer,
): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `${ts}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
}

export function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verify(
  secret: string,
  ts: string,
  method: string,
  path: string,
  body: Buffer,
  sig: string,
  nowS: number,
): { ok: boolean; reason?: string } {
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: "bad timestamp" };
  }

  if (Math.abs(nowS - tsNum) > SIGNATURE_WINDOW_S) {
    return { ok: false, reason: "timestamp outside window" };
  }

  const expected = sign(secret, signaturePayload(ts, method, path, body));
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig ?? "", "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad signature" };
  }

  return { ok: true };
}
