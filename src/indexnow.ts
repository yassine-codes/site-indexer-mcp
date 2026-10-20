import crypto from "node:crypto";
import type { Http } from "./http.js";

/**
 * IndexNow (Bing, Yandex, Seznam, Naver, Yep...). Google does NOT participate.
 * Protocol: https://www.indexnow.org/documentation
 */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export const isValidKey = (k: string) => /^[a-zA-Z0-9-]{8,128}$/.test(k);

export function generateKey(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function keyFile(origin: string, key: string) {
  return { fileName: `${key}.txt`, fileContent: key, url: new URL(`${key}.txt`, origin + "/").toString() };
}

export async function ping(
  h: Http,
  p: { host: string; key: string; keyLocation?: string; urls: string[] },
): Promise<{ submitted: number; endpoint: string }> {
  if (!isValidKey(p.key)) throw new Error("IndexNow key must be 8-128 chars of a-z, A-Z, 0-9 or '-'.");
  if (p.urls.length === 0) throw new Error("No URLs to submit.");
  if (p.urls.length > 10_000) throw new Error("IndexNow accepts at most 10,000 URLs per request.");
  const foreign = p.urls.filter((u) => new URL(u).hostname !== p.host);
  if (foreign.length) throw new Error(`All URLs must be on ${p.host}; got e.g. ${foreign[0]}`);
  await h.json({
    method: "POST",
    url: INDEXNOW_ENDPOINT,
    body: { host: p.host, key: p.key, ...(p.keyLocation ? { keyLocation: p.keyLocation } : {}), urlList: p.urls },
  });
  return { submitted: p.urls.length, endpoint: INDEXNOW_ENDPOINT };
}
