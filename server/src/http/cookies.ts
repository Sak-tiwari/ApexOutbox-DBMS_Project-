import { parseCookie, stringifySetCookie } from "cookie";
import type { Request, Response } from "express";
import type { Config } from "../config.js";

export const REFRESH_COOKIE = "apex_rt";
export const CSRF_COOKIE = "apex_csrf";
/** The refresh cookie is only ever sent to the auth endpoints, never to the rest of the API. */
export const AUTH_COOKIE_PATH = "/api/auth";

export function readCookies(req: Request): Record<string, string | undefined> {
  const header = req.headers.cookie;
  return header ? parseCookie(header) : {};
}

function append(res: Response, value: string) {
  const existing = res.getHeader("set-cookie");
  const list = Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : [];
  res.setHeader("set-cookie", [...list, value]);
}

/** HttpOnly (JavaScript cannot read it), SameSite=Strict, Secure in production, scoped to /api/auth. */
export function setRefreshCookie(res: Response, config: Config, token: string, maxAgeSeconds: number) {
  append(
    res,
    stringifySetCookie({
      name: REFRESH_COOKIE,
      value: token,
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "strict",
      path: AUTH_COOKIE_PATH,
      maxAge: maxAgeSeconds,
    }),
  );
}

export function clearRefreshCookie(res: Response, config: Config) {
  append(
    res,
    stringifySetCookie({
      name: REFRESH_COOKIE,
      value: "",
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "strict",
      path: AUTH_COOKIE_PATH,
      maxAge: 0,
    }),
  );
}

/** Readable by the SPA on purpose (double-submit CSRF token): it is useless without the HttpOnly cookie. */
export function setCsrfCookie(res: Response, config: Config, token: string, maxAgeSeconds: number) {
  append(
    res,
    stringifySetCookie({
      name: CSRF_COOKIE,
      value: token,
      httpOnly: false,
      secure: config.cookieSecure,
      sameSite: "strict",
      path: "/",
      maxAge: maxAgeSeconds,
    }),
  );
}

export function clearCsrfCookie(res: Response, config: Config) {
  append(
    res,
    stringifySetCookie({
      name: CSRF_COOKIE,
      value: "",
      httpOnly: false,
      secure: config.cookieSecure,
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    }),
  );
}
