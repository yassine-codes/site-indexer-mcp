import crypto from "node:crypto";
import fs from "node:fs/promises";
import { SCOPES } from "../config.js";
import type { Http } from "../http.js";
import { TOKEN_ENDPOINT } from "./oauth.js";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export async function loadServiceAccount(file: string): Promise<ServiceAccountKey> {
  const key = JSON.parse(await fs.readFile(file, "utf8"));
  if (key.type !== "service_account" || !key.client_email || !key.private_key) {
    throw new Error(`${file} is not a service account key JSON.`);
  }
  return key;
}

export function signJwt(key: ServiceAccountKey, nowSec: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "RS256", typ: "JWT" });
  const claims = enc({
    iss: key.client_email,
    scope: SCOPES.join(" "),
    aud: key.token_uri ?? TOKEN_ENDPOINT,
    iat: nowSec,
    exp: nowSec + 3600,
  });
  const sig = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key).toString("base64url");
  return `${header}.${claims}.${sig}`;
}

export async function serviceAccountToken(h: Http, key: ServiceAccountKey, nowSec: number) {
  return h.json<{ access_token: string; expires_in: number }>({
    method: "POST",
    url: key.token_uri ?? TOKEN_ENDPOINT,
    form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(key, nowSec) },
  });
}
