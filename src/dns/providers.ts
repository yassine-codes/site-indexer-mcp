import type { Http } from "../http.js";

export interface DnsRecordRequest {
  /** Fully-qualified host, e.g. "example.com" or "abc.example.com". */
  host: string;
  type: "TXT" | "CNAME";
  value: string;
}

export interface DnsRecordResult {
  provider: "netlify" | "cloudflare";
  zone: string;
  created: boolean;
  detail: string;
}

/** Zone names from most to least specific: a.b.example.com -> [a.b.example.com, b.example.com, example.com]. */
export function candidateZones(host: string): string[] {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join("."));
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\.$/, "").replace(/^"|"$/g, "");

// ---------- Netlify DNS ----------
const NETLIFY = "https://api.netlify.com/api/v1";

interface NetlifyZone {
  id: string;
  name: string;
}
interface NetlifyRecord {
  id: string;
  hostname: string;
  type: string;
  value: string;
}

export async function netlifyUpsert(h: Http, token: string, rec: DnsRecordRequest): Promise<DnsRecordResult> {
  const zones = await h.json<NetlifyZone[]>({ method: "GET", url: `${NETLIFY}/dns_zones`, bearer: token }, () => [
    { id: "dry-run-zone", name: candidateZones(rec.host).at(-1)! },
  ]);
  const zone = candidateZones(rec.host)
    .map((name) => zones.find((z) => norm(z.name) === name))
    .find(Boolean);
  if (!zone) {
    throw new Error(`No Netlify DNS zone found for ${rec.host}. Is the domain using Netlify DNS nameservers?`);
  }
  const existing = await h.json<NetlifyRecord[]>(
    { method: "GET", url: `${NETLIFY}/dns_zones/${encodeURIComponent(zone.id)}/dns_records`, bearer: token },
    () => [],
  );
  if (existing.some((r) => r.type === rec.type && norm(r.hostname) === norm(rec.host) && norm(r.value) === norm(rec.value))) {
    return { provider: "netlify", zone: zone.name, created: false, detail: "Record already exists." };
  }
  await h.json({
    method: "POST",
    url: `${NETLIFY}/dns_zones/${encodeURIComponent(zone.id)}/dns_records`,
    bearer: token,
    body: { type: rec.type, hostname: rec.host, value: rec.value, ttl: 3600 },
  });
  return { provider: "netlify", zone: zone.name, created: true, detail: `Created ${rec.type} ${rec.host}.` };
}

// ---------- Cloudflare ----------
const CF = "https://api.cloudflare.com/client/v4";

interface CfList<T> {
  success: boolean;
  result: T[];
}

export async function cloudflareUpsert(h: Http, token: string, rec: DnsRecordRequest): Promise<DnsRecordResult> {
  let zone: { id: string; name: string } | undefined;
  for (const name of candidateZones(rec.host)) {
    const res = await h.json<CfList<{ id: string; name: string }>>(
      { method: "GET", url: `${CF}/zones?name=${encodeURIComponent(name)}`, bearer: token },
      () => ({ success: true, result: [{ id: "dry-run-zone", name }] }),
    );
    zone = res.result?.[0];
    if (zone) break;
  }
  if (!zone) throw new Error(`No Cloudflare zone visible to this token for ${rec.host}.`);

  const q = new URLSearchParams({ type: rec.type, name: rec.host });
  const existing = await h.json<CfList<{ content: string }>>(
    { method: "GET", url: `${CF}/zones/${zone.id}/dns_records?${q}`, bearer: token },
    () => ({ success: true, result: [] }),
  );
  if (existing.result?.some((r) => norm(r.content) === norm(rec.value))) {
    return { provider: "cloudflare", zone: zone.name, created: false, detail: "Record already exists." };
  }
  await h.json({
    method: "POST",
    url: `${CF}/zones/${zone.id}/dns_records`,
    bearer: token,
    // ttl 1 = "automatic"; never proxy a verification record.
    body: { type: rec.type, name: rec.host, content: rec.value, ttl: 1, ...(rec.type === "CNAME" ? { proxied: false } : {}) },
  });
  return { provider: "cloudflare", zone: zone.name, created: true, detail: `Created ${rec.type} ${rec.host}.` };
}
