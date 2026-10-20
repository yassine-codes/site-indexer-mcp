import { type Config, SCOPES } from "../config.js";
import type { Http } from "../http.js";
import { type LoopbackLogin, type OAuthClient, loadOAuthClient, refreshAccessToken, startLoopbackLogin } from "./oauth.js";
import { loadServiceAccount, serviceAccountToken } from "./serviceAccount.js";
import { TokenStore } from "./tokenStore.js";

export interface AuthStatus {
  mode: "oauth" | "service-account" | "dry-run";
  ready: boolean;
  clientConfigured: boolean;
  tokenFile?: string;
  scopes?: string[];
  loginInProgress?: boolean;
  lastLoginError?: string;
  hint?: string;
}

/**
 * Hands out short-lived access tokens. Refresh tokens live on disk (0600);
 * access tokens only in memory. Nothing here ever returns a secret to a tool.
 */
export class Auth {
  private cached?: { token: string; expiresAt: number };
  private pending?: LoopbackLogin;
  private lastLoginError?: string;
  readonly store: TokenStore;

  constructor(
    private readonly config: Config,
    private readonly http: Http,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new TokenStore(config.configDir);
  }

  private get mode(): AuthStatus["mode"] {
    if (this.config.dryRun) return "dry-run";
    return this.config.serviceAccountFile ? "service-account" : "oauth";
  }

  private async client(): Promise<OAuthClient | undefined> {
    return loadOAuthClient(this.config);
  }

  async status(): Promise<AuthStatus> {
    const mode = this.mode;
    if (mode === "dry-run") return { mode, ready: true, clientConfigured: true, hint: "Dry-run: no Google calls are made." };
    if (mode === "service-account") {
      return {
        mode,
        ready: true,
        clientConfigured: true,
        scopes: [...SCOPES],
        hint: "Service-account mode: properties belong to the service account, not to you. See README caveats.",
      };
    }
    let clientConfigured = false;
    let hint: string | undefined;
    try {
      clientConfigured = !!(await this.client());
    } catch (e: any) {
      hint = e.message;
    }
    const tok = await this.store.read();
    if (!clientConfigured && !hint) {
      hint = "Set GOOGLE_OAUTH_CLIENT_FILE (path to the Desktop client JSON) or GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET.";
    } else if (!tok) {
      hint = "Not signed in. Call auth_login (or run `npx site-indexer auth login` in a terminal).";
    }
    return {
      mode,
      ready: clientConfigured && !!tok,
      clientConfigured,
      tokenFile: this.store.file,
      scopes: tok?.scope.split(" "),
      loginInProgress: !!this.pending,
      lastLoginError: this.lastLoginError,
      hint,
    };
  }

  /**
   * Starts the loopback flow and returns immediately with the consent URL; the
   * local listener completes in the background and persists the refresh token.
   */
  async startLogin(opts: { timeoutMs?: number } = {}): Promise<{ authUrl: string; done: Promise<void> }> {
    if (this.mode !== "oauth") throw new Error(`auth_login is only needed in oauth mode (current: ${this.mode}).`);
    const client = await this.client();
    if (!client) throw new Error((await this.status()).hint);
    this.pending?.cancel();
    const login = await startLoopbackLogin(this.http, client, opts);
    this.pending = login;
    this.lastLoginError = undefined;
    const done = login.done
      .then(async (tok) => {
        if (!tok.refresh_token) throw new Error("Google did not return a refresh token. Revoke the app's access and retry.");
        await this.store.write({
          refresh_token: tok.refresh_token,
          scope: tok.scope ?? SCOPES.join(" "),
          client_id: client.clientId,
          created_at: new Date(this.now()).toISOString(),
        });
        this.cached = { token: tok.access_token, expiresAt: this.now() + (tok.expires_in - 60) * 1000 };
      })
      .catch((e: Error) => {
        this.lastLoginError = e.message;
        throw e;
      })
      .finally(() => {
        if (this.pending === login) this.pending = undefined;
      });
    done.catch(() => {}); // surfaced through status(); avoid unhandled rejection
    return { authUrl: login.authUrl, done };
  }

  async logout(): Promise<boolean> {
    this.cached = undefined;
    return this.store.clear();
  }

  async accessToken(): Promise<string> {
    if (this.mode === "dry-run") return "dry-run";
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.token;

    let res: { access_token: string; expires_in: number };
    if (this.mode === "service-account") {
      const key = await loadServiceAccount(this.config.serviceAccountFile!);
      res = await serviceAccountToken(this.http, key, Math.floor(this.now() / 1000));
    } else {
      const client = await this.client();
      const tok = await this.store.read();
      if (!client || !tok) throw new Error(`Not authenticated. ${(await this.status()).hint ?? ""}`.trim());
      res = await refreshAccessToken(this.http, client, tok.refresh_token);
    }
    this.cached = { token: res.access_token, expiresAt: this.now() + (res.expires_in - 60) * 1000 };
    return res.access_token;
  }
}
