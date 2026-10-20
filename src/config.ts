import os from "node:os";
import path from "node:path";

export const SCOPES = [
  "https://www.googleapis.com/auth/siteverification",
  "https://www.googleapis.com/auth/webmasters",
] as const;

export interface Config {
  /** Directory holding token.json (and nothing else secret). */
  configDir: string;
  /** OAuth desktop client. Either id+secret or a client_secret JSON file. */
  clientId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  /** Optional service-account mode (see README caveats). */
  serviceAccountFile?: string;
  /** Extra owners added on verification (service-account mode). */
  extraOwners: string[];
  /** When true, no request leaves the machine; tools describe what they would do. */
  dryRun: boolean;
  /** When true, destructive tools are registered (they still need confirm=<site>). */
  enableDestructive: boolean;
  netlifyToken?: string;
  cloudflareToken?: string;
  indexNowKey?: string;
}

/** Per-OS config dir: XDG on Linux, Application Support on macOS, APPDATA on Windows. */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.SITE_INDEXER_CONFIG_DIR) return env.SITE_INDEXER_CONFIG_DIR;
  const home = os.homedir();
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "site-indexer");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "site-indexer");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "site-indexer");
}

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v.trim());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    configDir: defaultConfigDir(env),
    clientId: env.GOOGLE_OAUTH_CLIENT_ID || undefined,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || undefined,
    clientSecretFile: env.GOOGLE_OAUTH_CLIENT_FILE || undefined,
    serviceAccountFile: env.GOOGLE_SERVICE_ACCOUNT_FILE || undefined,
    extraOwners: (env.SITE_INDEXER_EXTRA_OWNERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dryRun: truthy(env.SITE_INDEXER_DRY_RUN),
    enableDestructive: truthy(env.SITE_INDEXER_ENABLE_DESTRUCTIVE),
    netlifyToken: env.NETLIFY_AUTH_TOKEN || undefined,
    cloudflareToken: env.CLOUDFLARE_API_TOKEN || undefined,
    indexNowKey: env.INDEXNOW_KEY || undefined,
  };
}
