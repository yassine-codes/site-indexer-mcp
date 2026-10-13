import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Auth } from "../src/auth/index.js";
import { buildAuthUrl, loadOAuthClient } from "../src/auth/oauth.js";
import { signJwt } from "../src/auth/serviceAccount.js";
import { TokenStore } from "../src/auth/tokenStore.js";
import { defaultConfigDir } from "../src/config.js";
import { Http } from "../src/http.js";
import { mockFetch, tempDir, testConfig } from "./helpers.js";

describe("config dir", () => {
  it("follows OS conventions and honours the override", () => {
    expect(defaultConfigDir({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe("/x/site-indexer");
    expect(defaultConfigDir({}, "darwin")).toMatch(/Library\/Application Support\/site-indexer$/);
    expect(defaultConfigDir({ APPDATA: "C:\\A" }, "win32")).toMatch(/site-indexer$/);
    expect(defaultConfigDir({ SITE_INDEXER_CONFIG_DIR: "/custom" }, "linux")).toBe("/custom");
  });
});

describe("TokenStore", () => {
  it.skipIf(process.platform === "win32")("writes token.json with 0600 in a 0700 dir", async () => {
    const dir = path.join(tempDir(), "nested");
    const s = new TokenStore(dir);
    await s.write({ refresh_token: "rt", scope: "s", client_id: "c", created_at: "t" });
    expect(fs.statSync(s.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect((await s.read())?.refresh_token).toBe("rt");
    expect(await s.clear()).toBe(true);
    expect(await s.read()).toBeUndefined();
  });
});

describe("OAuth client loading", () => {
  it("reads a downloaded Desktop client JSON", async () => {
    const f = path.join(tempDir(), "client.json");
    fs.writeFileSync(f, JSON.stringify({ installed: { client_id: "id1", client_secret: "sec1" } }));
    expect(await loadOAuthClient({ clientSecretFile: f })).toEqual({ clientId: "id1", clientSecret: "sec1" });
  });

  it("builds a PKCE, offline, consent URL with both scopes", () => {
    const u = new URL(buildAuthUrl({ clientId: "id", redirectUri: "http://127.0.0.1:5555/", challenge: "ch", state: "st" }));
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/siteverification https://www.googleapis.com/auth/webmasters",
    );
  });
});

describe("Auth", () => {
  it("status never leaks the refresh token and explains what is missing", async () => {
    const config = testConfig({ clientId: undefined, clientSecret: undefined });
    const auth = new Auth(config, new Http());
    let st = await auth.status();
    expect(st).toMatchObject({ ready: false, clientConfigured: false });
    expect(st.hint).toMatch(/GOOGLE_OAUTH_CLIENT_FILE/);

    const auth2 = new Auth(testConfig(), new Http());
    await auth2.store.write({ refresh_token: "SUPER-SECRET", scope: "a b", client_id: "c", created_at: "t" });
    st = await auth2.status();
    expect(st.ready).toBe(true);
    expect(JSON.stringify(st)).not.toMatch(/SUPER-SECRET/);
  });

  it("refreshes once and caches the access token", async () => {
    const m = mockFetch();
    m.on("POST", "https://oauth2.googleapis.com/token", (c) => ({ json: { access_token: `at-${c.body.refresh_token}`, expires_in: 3600 } }));
    const auth = new Auth(testConfig(), new Http({ fetch: m.fetch }));
    await auth.store.write({ refresh_token: "rt", scope: "s", client_id: "c", created_at: "t" });
    expect(await auth.accessToken()).toBe("at-rt");
    expect(await auth.accessToken()).toBe("at-rt");
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].body).toMatchObject({ grant_type: "refresh_token", client_secret: "csecret" });
  });

  it("explains invalid_grant (7-day Testing-mode expiry)", async () => {
    const m = mockFetch();
    m.on("POST", /token/, { status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
    const auth = new Auth(testConfig(), new Http({ fetch: m.fetch }));
    await auth.store.write({ refresh_token: "rt", scope: "s", client_id: "c", created_at: "t" });
    await expect(auth.accessToken()).rejects.toThrow(/In production/);
  });

  it("completes the loopback flow end to end and persists the refresh token", async () => {
    const m = mockFetch();
    m.on("POST", "https://oauth2.googleapis.com/token", (c) => {
      expect(c.body).toMatchObject({ grant_type: "authorization_code", code: "CODE123" });
      expect(c.body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return { json: { access_token: "at", refresh_token: "rt-new", expires_in: 3600, scope: "a b" } };
    });
    const auth = new Auth(testConfig(), new Http({ fetch: m.fetch }));
    const { authUrl, done } = await auth.startLogin({ timeoutMs: 10_000 });
    const u = new URL(authUrl);
    const redirect = u.searchParams.get("redirect_uri")!;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    // wrong state is rejected and does not end the flow
    const bad = await fetch(`${redirect}?code=X&state=wrong`);
    expect(bad.status).toBe(400);

    const res = await fetch(`${redirect}?code=CODE123&state=${u.searchParams.get("state")}`);
    expect(res.status).toBe(200);
    await done;
    expect((await auth.store.read())?.refresh_token).toBe("rt-new");
    expect((await auth.status()).ready).toBe(true);
  });
});

describe("service account JWT", () => {
  it("is a valid RS256 JWT for both scopes", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = signJwt({ client_email: "sa@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string }, 1000);
    const [h, c, s] = jwt.split(".");
    expect(crypto.createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims).toMatchObject({ iss: "sa@p.iam.gserviceaccount.com", aud: "https://oauth2.googleapis.com/token", exp: 4600 });
    expect(claims.scope).toContain("siteverification");
  });
});
