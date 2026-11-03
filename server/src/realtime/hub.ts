import type pg from "pg";
import type { Db } from "../db/pool.js";
import type { Log } from "../logger.js";

export interface ChangeEvent {
  /** lead | client | invoice | email | scrape_job, or "*" meaning "something may have changed, refetch everything". */
  entity: string;
  id: string;
  op: "INSERT" | "UPDATE";
}

type Listener = (event: ChangeEvent) => void;

/**
 * One dedicated Postgres connection LISTENs on `apex_changes` (fed by the triggers in migration 001) and fans each
 * notification out to the open streams of the SAME workspace only. A notification carries ids, never data: the browser
 * refetches through the normal authenticated API, so real time can never reveal more than a normal request would.
 */
export class RealtimeHub {
  private readonly subscribers = new Map<string, Set<Listener>>();
  private client: pg.PoolClient | undefined;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;

  constructor(private readonly db: Db, private readonly log: Log) {}

  async start() {
    await this.connect();
  }

  private async connect() {
    if (this.closed) return;
    try {
      const client = await this.db.connect();
      this.client = client;
      client.on("notification", (msg) => this.dispatch(msg.payload));
      client.on("error", (err) => this.lost(err));
      client.on("end", () => this.lost(new Error("connection ended")));
      await client.query("LISTEN apex_changes");
      this.attempt = 0;
      // Anything that changed while we were disconnected is unknown, so tell every stream to refetch.
      for (const set of this.subscribers.values()) for (const l of set) l({ entity: "*", id: "", op: "UPDATE" });
    } catch (err) {
      this.lost(err as Error);
    }
  }

  private lost(err: Error) {
    if (this.closed || this.reconnectTimer) return;
    this.log.warn({ err: err.message }, "realtime listener lost; reconnecting");
    try { this.client?.release(true); } catch { /* already gone */ }
    this.client = undefined;
    const delay = Math.min(30_000, 500 * 2 ** this.attempt++);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect(); }, delay);
    this.reconnectTimer.unref();
  }

  private dispatch(payload: string | undefined) {
    if (!payload) return;
    let p: { t?: string; e?: string; id?: string; op?: string };
    try { p = JSON.parse(payload); } catch { return; }
    if (!p.t || !p.e || !p.id) return;
    const set = this.subscribers.get(p.t);
    if (!set) return;
    const event: ChangeEvent = { entity: p.e, id: p.id, op: p.op === "INSERT" ? "INSERT" : "UPDATE" };
    for (const l of set) l(event);
  }

  subscribe(tenantId: string, listener: Listener): () => void {
    let set = this.subscribers.get(tenantId);
    if (!set) this.subscribers.set(tenantId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.subscribers.delete(tenantId);
    };
  }

  async close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    try { await this.client?.query("UNLISTEN apex_changes"); } catch { /* ignore */ }
    try { this.client?.release(); } catch { /* ignore */ }
    this.client = undefined;
    this.subscribers.clear();
  }
}
