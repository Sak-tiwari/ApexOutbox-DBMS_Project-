/**
 * API client. The access token lives ONLY in memory (never localStorage: XSS could read it). The long-lived refresh token is an
 * httpOnly cookie the browser sends by itself; refreshing also needs the CSRF double-submit header. Concurrent 401s share ONE refresh
 * call, because refresh tokens are single-use and rotate.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public retryAfter?: number) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
let onAuthLost: () => void = () => {};

export const setAccessToken = (t: string | null) => { accessToken = t; };
export const getAccessToken = () => accessToken;
export const setAuthLostHandler = (fn: () => void) => { onAuthLost = fn; };

const cookie = (name: string) => {
  const m = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
};

async function parseError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; details?: unknown } } = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  const retry = Number(res.headers.get("Retry-After"));
  return new ApiError(res.status, body.error?.code ?? "ERROR", body.error?.message ?? `Request failed (${res.status})`, body.error?.details, retry > 0 ? retry : undefined);
}

export interface SessionResponse { accessToken: string; expiresIn: number; user: import("./types").User }

export function refreshSession(): Promise<string | null> {
  refreshing ??= (async () => {
    // No CSRF cookie means no session was ever started here: skip the doomed (403) request.
    if (!cookie("apex_csrf")) { accessToken = null; refreshing = null; return null; }
    try {
      const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "include", headers: { "X-CSRF-Token": cookie("apex_csrf") } });
      if (!res.ok) { accessToken = null; return null; }
      const data = (await res.json()) as SessionResponse;
      accessToken = data.accessToken;
      return accessToken;
    } catch {
      return null; // offline: keep the session, the caller surfaces a network error
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export interface RequestOptions { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined | null>; signal?: AbortSignal; raw?: string }

export function buildUrl(path: string, query?: RequestOptions["query"]) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return `/api${path}${s ? `?${s}` : ""}`;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const send = () => {
    const headers: Record<string, string> = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (opts.method && opts.method !== "GET") headers["X-CSRF-Token"] = cookie("apex_csrf");
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.raw !== undefined) headers["Content-Type"] = "text/csv";
    return fetch(buildUrl(path, opts.query), {
      method: opts.method ?? "GET", credentials: "include", headers, signal: opts.signal,
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  };
  let res = await send();
  if (res.status === 401 && !path.startsWith("/auth/")) {
    const t = await refreshSession();
    if (!t) { onAuthLost(); throw await parseError(res); }
    res = await send();
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function downloadPdf(path: string, filename: string) {
  const fetchIt = () => fetch(`/api${path}`, { credentials: "include", headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  let res = await fetchIt();
  if (res.status === 401 && (await refreshSession())) res = await fetchIt();
  if (!res.ok) throw await parseError(res);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
