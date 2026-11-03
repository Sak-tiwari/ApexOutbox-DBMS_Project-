import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, refreshSession, setAccessToken } from "./api";
import { money } from "./format";
import { parseSse } from "./realtime";

describe("parseSse", () => {
  it("parses events, ignores comments, keeps partial tail", () => {
    const r = parseSse(': keep-alive\n\nevent: change\ndata: {"e":"lead"}\n\nevent: rea');
    expect(r.events).toEqual([{ event: "change", data: '{"e":"lead"}' }]);
    expect(r.rest).toBe("event: rea");
  });
  it("handles CRLF and multi-line data", () => {
    const r = parseSse("event: x\r\ndata: a\r\ndata: b\r\n\r\n");
    expect(r.events).toEqual([{ event: "x", data: "a\nb" }]);
  });
});

describe("api", () => {
  beforeEach(() => { document.cookie = "apex_csrf=tok123"; });
  afterEach(() => { vi.restoreAllMocks(); setAccessToken(null); });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("shares ONE refresh between concurrent 401s and retries with the new token", async () => {
    setAccessToken("old");
    let refreshCalls = 0;
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/refresh") { refreshCalls++; await new Promise((r) => setTimeout(r, 10)); return json(200, { accessToken: "new", expiresIn: 600, user: {} }); }
      const auth = (init?.headers as Record<string, string>).Authorization!;
      seen.push(auth);
      return auth === "Bearer new" ? json(200, { ok: true }) : json(401, { error: { code: "UNAUTHORIZED", message: "no" } });
    }));
    const [a, b] = await Promise.all([api("/leads"), api("/leads/stats")]);
    expect(a).toEqual({ ok: true }); expect(b).toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
  });

  it("surfaces the server error envelope and never leaks to localStorage", async () => {
    setAccessToken("t");
    vi.stubGlobal("fetch", vi.fn(async () => json(422, { error: { code: "DEAL_REQUIRED", message: "Add a deal" } })));
    await expect(api("/leads/1/transition", { method: "POST", body: {} })).rejects.toMatchObject({ status: 422, code: "DEAL_REQUIRED", message: "Add a deal" });
    expect(localStorage.length).toBe(0);
  });

  it("calls the auth-lost handler when refresh fails", async () => {
    const { setAuthLostHandler } = await import("./api");
    const lost = vi.fn();
    setAuthLostHandler(lost);
    setAccessToken("t");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/api/auth/refresh" ? json(401, {}) : json(401, { error: { code: "UNAUTHORIZED", message: "x" } }))));
    await expect(api("/leads")).rejects.toBeInstanceOf(ApiError);
    expect(lost).toHaveBeenCalled();
    expect(await refreshSession()).toBeNull();
  });

  it("sends the CSRF header on writes", async () => {
    const f = vi.fn(async () => json(200, {}));
    vi.stubGlobal("fetch", f);
    await api("/leads", { method: "POST", body: {} });
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ "X-CSRF-Token": "tok123" });
  });
});

describe("money", () => {
  it("formats minor units", () => expect(money(123456, "INR")).toContain("1,234.56"));
});
