import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SCOPES } from "../config.js";
import { Http, HttpError } from "../http.js";

export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Reads the Desktop OAuth client from env vars or a downloaded client_secret_*.json. */
export async function loadOAuthClient(opts: {
  clientId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
}): Promise<OAuthClient | undefined> {
  if (opts.clientId && opts.clientSecret) return { clientId: opts.clientId, clientSecret: opts.clientSecret };
  if (!opts.clientSecretFile) return undefined;
  const raw = JSON.parse(await fs.readFile(opts.clientSecretFile, "utf8"));
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) {
    throw new Error(`${opts.clientSecretFile} does not look like an OAuth client JSON (missing client_id/client_secret).`);
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    // Force a refresh_token even if the user consented before.
    prompt: "consent",
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
  });
  return `${AUTH_ENDPOINT}?${q}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export async function exchangeCode(
  h: Http,
  client: OAuthClient,
  p: { code: string; redirectUri: string; verifier: string },
): Promise<TokenResponse> {
  return h.json<TokenResponse>({
    method: "POST",
    url: TOKEN_ENDPOINT,
    form: {
      code: p.code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: p.redirectUri,
      grant_type: "authorization_code",
      code_verifier: p.verifier,
    },
  });
}

export async function refreshAccessToken(h: Http, client: OAuthClient, refreshToken: string): Promise<TokenResponse> {
  try {
    return await h.json<TokenResponse>({
      method: "POST",
      url: TOKEN_ENDPOINT,
      form: {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      },
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 400 && /invalid_grant|expired|revoked/i.test(JSON.stringify(e.body))) {
      throw new Error(
        "The stored Google refresh token was rejected (expired or revoked). Run auth_login again. " +
          "If this happens every ~7 days, your OAuth consent screen is still in 'Testing': publish it to 'In production'.",
      );
    }
    throw e;
  }
}

export interface LoopbackLogin {
  authUrl: string;
  redirectUri: string;
  /** Resolves with the token response once the browser hits the loopback URL. */
  done: Promise<TokenResponse>;
  cancel: () => void;
}

const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>site-indexer</title><body style="font-family:system-ui;padding:2rem"><h1>site-indexer</h1><p>${msg}</p></body>`;

/**
 * Starts a one-shot HTTP server on 127.0.0.1 (random port) per Google's loopback
 * flow for installed apps, with PKCE and a random state.
 */
export async function startLoopbackLogin(
  h: Http,
  client: OAuthClient,
  opts: { timeoutMs?: number; port?: number } = {},
): Promise<LoopbackLogin> {
  const { verifier, challenge } = pkcePair();
  const state = b64url(crypto.randomBytes(16));
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/`;
  let timer: NodeJS.Timeout | undefined;
  const close = () => {
    if (timer) clearTimeout(timer);
    server.close();
  };

  const done = new Promise<TokenResponse>((resolve, reject) => {
    timer = setTimeout(() => {
      close();
      reject(new Error("Timed out waiting for the Google consent redirect."));
    }, opts.timeoutMs ?? 5 * 60_000);
    timer.unref?.();

    server.on("request", async (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (!code && !error) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400).end(PAGE("State mismatch. Start the login again."));
        return;
      }
      if (error) {
        res.writeHead(400).end(PAGE(`Google returned an error: ${error.replace(/[<>&]/g, "")}`));
        close();
        reject(new Error(`Google consent failed: ${error}`));
        return;
      }
      try {
        const tok = await exchangeCode(h, client, { code: code!, redirectUri, verifier });
        res.writeHead(200).end(PAGE("Signed in. You can close this tab and return to Claude."));
        resolve(tok);
      } catch (e) {
        res.writeHead(500).end(PAGE("Token exchange failed. Check the site-indexer logs."));
        reject(e);
      } finally {
        close();
      }
    });
  });

  return {
    authUrl: buildAuthUrl({ clientId: client.clientId, redirectUri, challenge, state }),
    redirectUri,
    done,
    cancel: close,
  };
}
