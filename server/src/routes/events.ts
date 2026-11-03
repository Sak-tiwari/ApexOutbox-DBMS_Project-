import { Router } from "express";
import { TooManyRequestsError } from "../errors.js";
import type { AuthMiddleware } from "../middleware/auth.js";
import { authOf } from "../middleware/auth.js";
import type { RealtimeHub } from "../realtime/hub.js";

const MAX_STREAMS_PER_USER = 5;
/** Shorter than the access token lifetime, so a stream never outlives the sign-in that opened it. */
const MAX_STREAM_MS = 9 * 60_000;
const HEARTBEAT_MS = 25_000;

export function createEventsRouter(deps: { hub: RealtimeHub; auth: AuthMiddleware; maxStreamMs?: number; heartbeatMs?: number }) {
  const { hub, auth } = deps;
  const router = Router();
  const open = new Map<string, number>();

  // Server-Sent Events. The browser uses fetch() (not EventSource) so it can send the Authorization header.
  router.get("/", auth.requireAuth(), (req, res) => {
    const a = authOf(req);
    if ((open.get(a.userId) ?? 0) >= MAX_STREAMS_PER_USER) throw new TooManyRequestsError("Too many open live connections. Close another tab.", 10);
    open.set(a.userId, (open.get(a.userId) ?? 0) + 1);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // tell nginx not to buffer the stream
    });
    res.write("retry: 3000\n\n");
    res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

    const unsubscribe = hub.subscribe(a.tenantId, (e) => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`));
    const beat = setInterval(() => res.write(": keep-alive\n\n"), deps.heartbeatMs ?? HEARTBEAT_MS);
    const expire = setTimeout(() => { res.write("event: expired\ndata: {}\n\n"); res.end(); }, deps.maxStreamMs ?? MAX_STREAM_MS);

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearInterval(beat);
      clearTimeout(expire);
      unsubscribe();
      const n = (open.get(a.userId) ?? 1) - 1;
      if (n <= 0) open.delete(a.userId); else open.set(a.userId, n);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  });
  return router;
}
