import fs from "node:fs/promises";
import path from "node:path";

export interface StoredToken {
  refresh_token: string;
  scope: string;
  client_id: string;
  created_at: string;
}

export class TokenStore {
  readonly file: string;

  constructor(configDir: string) {
    this.file = path.join(configDir, "token.json");
  }

  async read(): Promise<StoredToken | undefined> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as StoredToken;
      return parsed.refresh_token ? parsed : undefined;
    } catch (e: any) {
      if (e?.code === "ENOENT") return undefined;
      throw new Error(`Could not read token file ${this.file}: ${e?.message ?? e}`);
    }
  }

  /** Writes with 0600 (file) / 0700 (dir). chmod afterwards because `mode` only applies on create. */
  async write(token: StoredToken): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
    await fs.chmod(tmp, 0o600).catch(() => {});
    await fs.rename(tmp, this.file);
  }

  async clear(): Promise<boolean> {
    try {
      await fs.unlink(this.file);
      return true;
    } catch (e: any) {
      if (e?.code === "ENOENT") return false;
      throw e;
    }
  }
}
