/** Tiny Prometheus-format metrics: in-process counters plus gauges computed at scrape time. */
export class Metrics {
  private counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = `${name}${Metrics.fmt(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  private static fmt(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (!entries.length) return "";
    return `{${entries.map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "")}"`).join(",")}}`;
  }

  async render(gauges?: () => Promise<Record<string, number>>): Promise<string> {
    const lines: string[] = [];
    for (const [key, value] of [...this.counters.entries()].sort()) lines.push(`${key} ${value}`);
    if (gauges) {
      try {
        for (const [name, value] of Object.entries(await gauges())) lines.push(`${name} ${value}`);
      } catch {
        lines.push("apexoutbox_gauges_error 1");
      }
    }
    return lines.join("\n") + "\n";
  }
}
