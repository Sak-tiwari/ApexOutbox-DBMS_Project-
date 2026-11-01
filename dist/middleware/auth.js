"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiKeyAuth = apiKeyAuth;
const node_crypto_1 = require("node:crypto");
const errors_1 = require("../errors");
function safeEqual(a, b) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && (0, node_crypto_1.timingSafeEqual)(ba, bb);
}
/**
 * API-key authentication. The caller proves who they are with a secret key; the user id comes from
 * the server-side key map. Phase 3's `x-user-id` header was removed on purpose: it let any caller
 * claim to be any lead owner.
 */
function apiKeyAuth(keys) {
    return (req, _res, next) => {
        const header = req.header("authorization") ?? "";
        const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : (req.header("x-api-key") ?? "");
        if (!presented)
            return next(new errors_1.UnauthenticatedError());
        let userId;
        for (const [key, user] of keys) {
            // Compare against every key so timing does not reveal which prefix matched.
            if (safeEqual(key, presented))
                userId = user;
        }
        if (!userId)
            return next(new errors_1.UnauthenticatedError());
        req.userId = userId;
        next();
    };
}
//# sourceMappingURL=auth.js.map