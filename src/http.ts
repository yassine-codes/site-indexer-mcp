export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  body?: unknown;
  /** Raw form body (OAuth token endpoint). Mutually exclusive with body. */
  form?: Record<string, string>;
  /** Bearer token; never logged. */
  bearer?: string;
  headers?: Record<string, string>;
}

export interface DryRunEntry {
  method: string;
  url: string;
  body?: unknown;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly detail: string,
    readonly body: unknown,
  ) {
    super(`${method} ${url} failed with HTTP ${status}: ${detail}`);
    this.name = "HttpError";
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pulls a human-readable message out of Google / Netlify / Cloudflare error bodies. */
function errorDetail(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, any>;
    if (typeof b.error === "object" && b.error?.message) return String(b.error.message);
    if (typeof b.error_description === "string") return b.error_description;
    if (typeof b.error === "string") return b.error;
    if (typeof b.message === "string") return b.message;
    if (Array.isArray(b.errors) && b.errors[0]?.message) return String(b.errors[0].message);
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  return fallback;
}

export interface HttpOptions {
  fetch?: FetchLike;
  dryRun?: boolean;
  /** Retries for 429/5xx. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Tiny JSON-over-fetch client. In dry-run mode no request leaves the process:
 * the request is recorded (without credentials) and `dryRunResult` is returned.
 */
export class Http {
  readonly dryRun: boolean;
  readonly dryRunLog: DryRunEntry[] = [];
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.dryRun = opts.dryRun ?? false;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? sleep;
  }

  async json<T>(req: HttpRequest, dryRunResult?: () => T): Promise<T> {
    if (this.dryRun) {
      this.dryRunLog.push({ method: req.method, url: req.url, body: req.form ? "<form>" : req.body });
      return (dryRunResult ? dryRunResult() : ({} as T));
    }
    const headers: Record<string, string> = { accept: "application/json", ...req.headers };
    let body: string | undefined;
    if (req.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(req.form).toString();
    } else if (req.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.body);
    }
    if (req.bearer) headers.authorization = `Bearer ${req.bearer}`;

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(req.url, { method: req.method, headers, body });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        /* keep raw text */
      }
      if (res.ok) return parsed as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      throw new HttpError(res.status, req.method, req.url, errorDetail(parsed, res.statusText), parsed);
    }
  }

  /**
   * Plain unauthenticated GET of the public site (verification file, sitemap).
   * Runs even in dry-run: it reads nothing private and changes nothing.
   */
  async fetchText(url: string): Promise<{ status: number; text: string; finalUrl: string }> {
    const res = await this.fetchImpl(url, { method: "GET", redirect: "follow" });
    return { status: res.status, text: await res.text(), finalUrl: res.url || url };
  }
}
