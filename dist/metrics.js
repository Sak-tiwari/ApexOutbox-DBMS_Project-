"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Metrics = void 0;
/** Tiny Prometheus-format metrics: in-process counters plus gauges computed at scrape time. */
class Metrics {
    counters = new Map();
    inc(name, labels = {}, by = 1) {
        const key = `${name}${Metrics.fmt(labels)}`;
        this.counters.set(key, (this.counters.get(key) ?? 0) + by);
    }
    static fmt(labels) {
        const entries = Object.entries(labels);
        if (!entries.length)
            return "";
        return `{${entries.map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "")}"`).join(",")}}`;
    }
    async render(gauges) {
        const lines = [];
        for (const [key, value] of [...this.counters.entries()].sort())
            lines.push(`${key} ${value}`);
        if (gauges) {
            try {
                for (const [name, value] of Object.entries(await gauges()))
                    lines.push(`${name} ${value}`);
            }
            catch {
                lines.push("apexoutbox_gauges_error 1");
            }
        }
        return lines.join("\n") + "\n";
    }
}
exports.Metrics = Metrics;
//# sourceMappingURL=metrics.js.map