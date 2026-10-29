import { createSign } from "node:crypto";

// Google Play purchases arrive as purchase tokens; the Android Publisher
// API says whether a token is a completed purchase of that product in
// that app. The server signs in as a service account that has been
// granted access in the Play Console (Users and permissions).

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export type GoogleCheck =
  | { valid: true; orderId?: string; test: boolean }
  | { valid: false; reason: string };

export type GoogleVerifier = (packageName: string, productId: string, token: string) => Promise<GoogleCheck>;

// Google could not be asked (network, credentials, outage): the client
// keeps the purchase unfinished and asks again later.
export class StoreUnavailable extends Error {}

export function googleVerifier(account: ServiceAccount, fetchImpl: typeof fetch = fetch): GoogleVerifier {
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  let cached: { token: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    const nowS = Math.floor(Date.now() / 1000);
    if (cached && cached.expiresAt - 60 > nowS) {
      return cached.token;
    }

    const header = base64url({ alg: "RS256", typ: "JWT" });
    const claims = base64url({ iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: nowS, exp: nowS + 3600 });
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.private_key, "base64url");
    const response = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${signature}`,
      }),
    });
    if (!response.ok) {
      throw new StoreUnavailable(`google sign-in answered ${response.status}`);
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: nowS + body.expires_in };
    return cached.token;
  }

  return async (packageName, productId, token) => {
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}` +
      `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetchImpl(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    } catch (error) {
      throw error instanceof StoreUnavailable ? error : new StoreUnavailable(String(error));
    }

    // Unknown, malformed or expired tokens: not a purchase.
    if (response.status === 400 || response.status === 404 || response.status === 410) {
      return { valid: false, reason: `google answered ${response.status}` };
    }

    if (!response.ok) {
      throw new StoreUnavailable(`google answered ${response.status}`);
    }

    const purchase = (await response.json()) as { purchaseState?: number; orderId?: string; purchaseType?: number };
    if (purchase.purchaseState !== 0) {
      return { valid: false, reason: purchase.purchaseState === 2 ? "payment pending" : "purchase cancelled" };
    }

    // purchaseType 0: a license tester's purchase, no money moved.
    return { valid: true, orderId: purchase.orderId, test: purchase.purchaseType === 0 };
  };
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
