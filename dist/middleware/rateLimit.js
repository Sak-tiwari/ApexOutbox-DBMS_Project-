"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimit = rateLimit;
/**
 * Small fixed-window limiter keyed by client IP (runs BEFORE authentication, so it also slows down
 * API-key guessing). State is per process: behind several API replicas the effective limit is
 * limit x replicas. Put a reverse proxy / gateway limiter in front for a hard global limit, and set
 * Express "trust proxy" there so req.ip is the real client address.
 */
function rateLimit(options) {
    const windowMs = options.windowMs ?? 60_000;
    const now = options.now ?? Date.now;
    const hits = new Map();
    return (req, res, next) => {
        if (options.limit <= 0)
            return next();
        const t = now();
        if (hits.size > 10_000)
            for (const [k, v] of hits)
                if (v.resetAt <= t)
                    hits.delete(k);
        const key = req.ip || 'unknown';
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= t) {
            entry = { count: 0, resetAt: t + windowMs };
            hits.set(key, entry);
        }
        entry.count += 1;
        res.setHeader('RateLimit-Limit', String(options.limit));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, options.limit - entry.count)));
        if (entry.count > options.limit) {
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))));
            return res.status(429).json({ success: false, error: 'Too many requests', code: 'RATE_LIMITED' });
        }
        next();
    };
}
//# sourceMappingURL=rateLimit.js.map