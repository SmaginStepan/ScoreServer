// Purchase checks end to end: temp DB, in-process app, a stand-in Apple
// signing chain (test/fixtures/apple, built by make-chain.sh) and a fake
// Google API. Run `npm run build` first.
import { createHash, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, verify, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const { openDb } = await import("../dist/db.js");
const { createApp } = await import("../dist/app.js");
const { googleVerifier, StoreUnavailable } = await import("../dist/stores/google.js");
const { verifyAppleTransaction } = await import("../dist/stores/apple.js");

const fixtures = new URL("./fixtures/apple/", import.meta.url);
const pem = (name) => readFileSync(new URL(name, fixtures), "utf8");
const der = (name) => new X509Certificate(pem(name)).raw.toString("base64");
const chain = [der("leaf.pem"), der("intermediate.pem"), der("root.pem")];
const rootFingerprint = new X509Certificate(pem("root.pem")).fingerprint256;
const leafKey = createPrivateKey(pem("leaf.key"));

// A StoreKit 2 style signed transaction from the stand-in chain.
function appleJws(fields, x5c = chain) {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", x5c })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    transactionId: "2000000123",
    originalTransactionId: "2000000123",
    bundleId: "com.test.app",
    productId: "essence_vial",
    type: "Consumable",
    environment: "Sandbox",
    signedDate: Date.now(),
    ...fields,
  })).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: leafKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

// ---- Apple's check on its own --------------------------------------------

assert.equal(verifyAppleTransaction(appleJws({}), rootFingerprint).valid, true, "the stand-in chain verifies");
assert.match(verifyAppleTransaction(appleJws({})).reason, /Apple's root/, "only Apple's real root is trusted by default");
assert.match(verifyAppleTransaction(appleJws({}, [chain[1], chain[0], chain[2]]), rootFingerprint).reason, /broken/);
const [h, , s] = appleJws({}).split(".");
const forged = Buffer.from(JSON.stringify({ transactionId: "1", bundleId: "com.test.app", productId: "essence_cauldron" })).toString("base64url");
assert.match(verifyAppleTransaction(`${h}.${forged}.${s}`, rootFingerprint).reason, /bad signature/, "an edited payload fails");
assert.match(verifyAppleTransaction("nonsense", rootFingerprint).reason, /not a signed transaction/);

// ---- Google's check against a fake API -----------------------------------

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = {
  client_email: "checker@test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: "https://oauth.test/token",
};
let tokenRequests = 0;
const fakeGoogle = async (url, init) => {
  if (url === account.token_uri) {
    tokenRequests++;
    const assertion = new URLSearchParams(String(init.body)).get("assertion");
    const [header, claims, signature] = assertion.split(".");
    assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")),
      "the service account signs its sign-in");
    return Response.json({ access_token: "access-1", expires_in: 3600 });
  }

  assert.equal(init.headers.Authorization, "Bearer access-1");
  const token = decodeURIComponent(url.split("/tokens/")[1]);
  if (token === "good") return Response.json({ purchaseState: 0, orderId: "GPA.1", purchaseType: 0 });
  if (token === "cancelled") return Response.json({ purchaseState: 1 });
  if (token === "down") return new Response("", { status: 503 });
  return new Response("", { status: 404 });
};
const checkGoogle = googleVerifier(account, fakeGoogle);
assert.deepEqual(await checkGoogle("com.test.app", "essence_vial", "good"), { valid: true, orderId: "GPA.1", test: true });
assert.equal((await checkGoogle("com.test.app", "essence_vial", "cancelled")).valid, false);
assert.equal((await checkGoogle("com.test.app", "essence_vial", "unknown")).valid, false);
await assert.rejects(checkGoogle("com.test.app", "essence_vial", "down"), StoreUnavailable);
assert.equal(tokenRequests, 1, "the sign-in is reused while it lasts");

// ---- The endpoint --------------------------------------------------------

const db = openDb(join(mkdtempSync(join(tmpdir(), "purchases-")), "test.db"));
const apiKey = randomBytes(8).toString("hex");
const secret = randomBytes(16).toString("hex");
db.prepare(
  `INSERT INTO games (id, name, api_key, hmac_secret, rotation, payload_private, max_score, min_interval_s)
   VALUES ('demo', 'Demo', ?, ?, 'none', 0, NULL, 0)`,
).run(apiKey, secret);
db.prepare(`INSERT INTO game_stores (game_id, store, app_id) VALUES ('demo', 'apple', 'com.test.app'), ('demo', 'google', 'com.test.app')`).run();

let googleDown = false;
const server = createApp(db, {
  purchases: {
    appleRootFingerprint: rootFingerprint,
    google: async (app, product, token) => {
      if (googleDown) throw new StoreUnavailable("outage");
      assert.equal(app, "com.test.app");
      return token.startsWith("good") ? { valid: true, test: false } : { valid: false, reason: "google answered 404" };
    },
  },
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function claim(body) {
  const path = "/v1/demo/purchases";
  const text = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash("sha256").update(Buffer.from(text)).digest("hex");
  const sig = createHmac("sha256", secret).update(`${ts}\nPOST\n${path}\n${bodyHash}`).digest("hex");
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey, "X-Ts": ts, "X-Sig": sig },
    body: text,
  });
  return { status: res.status, ...(await res.json()) };
}

const vial = appleJws({});
let result = await claim({ player_id: "p1", store: "apple", product_id: "essence_vial", token: vial });
assert.deepEqual(result, { status: 200, valid: true, product_id: "essence_vial", transaction_id: "2000000123", repeat: false });
result = await claim({ player_id: "p1", store: "apple", product_id: "essence_vial", token: vial });
assert.equal(result.repeat, true, "the same player may ask again");
result = await claim({ player_id: "p2", store: "apple", product_id: "essence_vial", token: vial });
assert.equal(result.valid, false, "a receipt replayed by someone else is refused");
result = await claim({ player_id: "p1", store: "apple", product_id: "essence_cauldron", token: appleJws({ transactionId: "7" }) });
assert.match(result.reason, /another product/);
result = await claim({ player_id: "p1", store: "apple", product_id: "essence_vial", token: appleJws({ transactionId: "8", bundleId: "com.other" }) });
assert.match(result.reason, /another app/);
result = await claim({ player_id: "p1", store: "apple", product_id: "essence_vial", token: appleJws({ transactionId: "9", revocationDate: Date.now() }) });
assert.match(result.reason, /refunded/);

result = await claim({ player_id: "p1", store: "google", product_id: "essence_flask", token: "good-1" });
assert.equal(result.valid, true);
assert.equal(result.transaction_id, "good-1");
result = await claim({ player_id: "p1", store: "google", product_id: "essence_flask", token: "made-up" });
assert.equal(result.valid, false);
googleDown = true;
result = await claim({ player_id: "p1", store: "google", product_id: "essence_flask", token: "good-2" });
assert.equal(result.status, 503, "a store that cannot be asked means try again later");
googleDown = false;
result = await claim({ player_id: "p1", store: "google", product_id: "essence_flask", token: "good-2" });
assert.equal(result.valid, true, "and the retry goes through");

const unsigned = await fetch(`${base}/v1/demo/purchases`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
  body: JSON.stringify({ player_id: "p1", store: "google", product_id: "essence_flask", token: "good-3" }),
});
assert.equal(unsigned.status, 401, "unsigned claims are rejected");

assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM purchases`).get().n, 3, "one row per granted transaction");

server.close();
console.log("purchases ok");
