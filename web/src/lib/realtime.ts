import type { QueryClient } from "@tanstack/react-query";
import { getAccessToken, refreshSession } from "./api";

/**
 * Live updates. The browser's EventSource can't send an Authorization header, so this uses fetch() and parses the SSE stream by hand.
 * The server sends ids only (never data): every event just invalidates the matching caches and TanStack Query refetches through the
 * normal authorised endpoints. On (re)connect we invalidate everything, because events may have been missed while disconnected.
 */
export type ChangeEvent = { t: string; e: "lead" | "client" | "invoice" | "email" | "scrape_job"; id: string; op: string };
export type LiveStatus = "connecting" | "live" | "offline";

const KEYS: Record<ChangeEvent["e"], string[][]> = {
  lead: [["leads"], ["lead-stats"]],
  client: [["clients"]],
  invoice: [["invoices"], ["invoice-stats"]],
  email: [["emails"], ["email-stats"], ["invoices"]],
  scrape_job: [["scrape-jobs"], ["leads"], ["lead-stats"]],
};

export function parseSse(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const events: { event: string; data: string }[] = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    let event = "message"; const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length || event !== "message") events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

export function startRealtime(qc: QueryClient, onStatus: (s: LiveStatus) => void) {
  let stopped = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();
  let flush: ReturnType<typeof setTimeout> | undefined;

  // Coalesce bursts (a scrape job inserts many leads) into one refetch per key.
  const invalidate = (keys: string[][]) => {
    for (const k of keys) pending.add(k[0]!);
    flush ??= setTimeout(() => {
      flush = undefined;
      for (const k of pending) void qc.invalidateQueries({ queryKey: [k] });
      pending.clear();
    }, 250);
  };

  const connect = async () => {
    if (stopped) return;
    onStatus("connecting");
    controller = new AbortController();
    try {
      let token = getAccessToken();
      if (!token) token = await refreshSession();
      if (!token) throw new Error("no session");
      let res = await fetch("/api/events", { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }, signal: controller.signal, credentials: "include" });
      if (res.status === 401) {
        token = await refreshSession();
        if (!token) throw new Error("no session");
        res = await fetch("/api/events", { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }, signal: controller.signal, credentials: "include" });
      }
      if (res.status === 429) throw Object.assign(new Error("too many streams"), { wait: Number(res.headers.get("Retry-After")) || 30 });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      attempt = 0;
      onStatus("live");
      invalidate([["leads"], ["lead-stats"], ["clients"], ["invoices"], ["invoice-stats"], ["emails"], ["email-stats"], ["scrape-jobs"]]);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parsed = parseSse(buf);
        buf = parsed.rest;
        for (const ev of parsed.events) {
          if (ev.event === "change") {
            try { const c = JSON.parse(ev.data) as ChangeEvent; if (KEYS[c.e]) invalidate(KEYS[c.e]); } catch { /* ignore malformed */ }
          }
          if (ev.event === "expired") return; // server rotates streams (token lifetime); reconnect below
        }
      }
    } catch (err) {
      if (stopped) return;
      onStatus("offline");
      const wait = (err as { wait?: number }).wait;
      attempt += 1;
      const delay = wait ? wait * 1000 : Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) + Math.random() * 500;
      timer = setTimeout(() => void connect(), delay);
      return;
    }
    if (!stopped) timer = setTimeout(() => void connect(), 500);
  };

  const onOnline = () => { if (!stopped) { clearTimeout(timer); controller?.abort(); void connect(); } };
  window.addEventListener("online", onOnline);
  void connect();
  return () => {
    stopped = true;
    clearTimeout(timer); clearTimeout(flush);
    controller?.abort();
    window.removeEventListener("online", onOnline);
  };
}
