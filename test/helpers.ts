import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Auth } from "../src/auth/index.js";
import { type Config, loadConfig } from "../src/config.js";
import { Http } from "../src/http.js";
import type { Ctx } from "../src/ops.js";

export interface Call {
  method: string;
  url: string;
  body?: any;
  headers: Record<string, string>;
}

type Handler = (call: Call) => { status?: number; json?: unknown; text?: string; url?: string } | undefined;

/**
 * A fetch stand-in: routes are tried in order; `once` routes are consumed.
 * Unmatched requests fail the test loudly so no real network is ever touched.
 */
export function mockFetch() {
  const calls: Call[] = [];
  const routes: { method: string; match: RegExp | string; handler: Handler; once: boolean }[] = [];
  const add = (once: boolean) => (method: string, match: RegExp | string, handler: Handler | object) =>
    routes.push({ method, match, handler: typeof handler === "function" ? (handler as Handler) : asSpec(handler), once });

  // `{ status | json | text }` is a response spec; any other object is a JSON body.
  const asSpec = (o: object): Handler => {
    const isSpec = Object.keys(o).some((k) => k === "status" || k === "json" || k === "text");
    return () => (isSpec ? (o as ReturnType<Handler>) : { json: o });
  };

  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    let body: any = init.body;
    if (typeof body === "string" && headers["content-type"]?.startsWith("application/json")) body = JSON.parse(body);
    if (typeof body === "string" && headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(body));
    }
    const call: Call = { method, url, body, headers };
    calls.push(call);
    const i = routes.findIndex(
      (r) => r.method === method && (typeof r.match === "string" ? url === r.match : r.match.test(url)),
    );
    if (i < 0) throw new Error(`Unmocked request: ${method} ${url}`);
    const r = routes[i];
    if (r.once) routes.splice(i, 1);
    const out = r.handler(call) ?? {};
    const text = out.text ?? (out.json !== undefined ? JSON.stringify(out.json) : "");
    const res = new Response(text, { status: out.status ?? 200 });
    Object.defineProperty(res, "url", { value: out.url ?? url });
    return res;
  };
  return { fetch: fetchImpl, calls, on: add(false), once: add(true) };
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "site-indexer-test-"));
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    configDir: tempDir(),
    clientId: "cid.apps.googleusercontent.com",
    clientSecret: "csecret",
    ...over,
  };
}

/** Ctx with a stored refresh token and a mocked token endpoint. */
export async function signedInCtx(over: Partial<Config> = {}) {
  const m = mockFetch();
  const config = testConfig(over);
  const http = new Http({ fetch: m.fetch, dryRun: config.dryRun, sleep: async () => {} });
  const auth = new Auth(config, http);
  await auth.store.write({ refresh_token: "rt-1", scope: "x", client_id: config.clientId!, created_at: "now" });
  m.on("POST", "https://oauth2.googleapis.com/token", { access_token: "at-1", expires_in: 3600 });
  let clock = 1_000_000;
  const ctx: Ctx = {
    config,
    http,
    auth,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { ctx, m, advance: (ms: number) => (clock += ms) };
}
