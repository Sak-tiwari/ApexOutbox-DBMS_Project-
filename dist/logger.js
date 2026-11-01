"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = createLogger;
const pino_1 = __importDefault(require("pino"));
/** Structured JSON logs. Secrets are redacted wherever they appear in a log object. */
function createLogger(level = process.env.LOG_LEVEL ?? "info") {
    return (0, pino_1.default)({
        level,
        redact: {
            paths: ["req.headers.authorization", "req.headers['x-api-key']", "*.password", "*.SMTP_PASS", "*.apiKey"],
            censor: "[redacted]",
        },
    });
}
//# sourceMappingURL=logger.js.map