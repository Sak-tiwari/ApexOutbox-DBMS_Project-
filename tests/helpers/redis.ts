import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import IORedis from "ioredis";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** A throwaway real redis-server that tests can stop and restart to simulate outages. */
export class TestRedis {
  private proc?: ChildProcess;
  constructor(public readonly port: number) {}
  get url() { return `redis://127.0.0.1:${this.port}`; }

  static async create() { return new TestRedis(await freePort()); }

  async start() {
    this.proc = spawn("redis-server", ["--port", String(this.port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
    const probe = new IORedis(this.url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    probe.on("error", () => {});
    for (let i = 0; i < 50; i++) {
      try { await probe.connect(); await probe.ping(); probe.disconnect(); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    probe.disconnect();
    throw new Error("redis-server did not start");
  }

  async stop() {
    const p = this.proc;
    if (!p) return;
    this.proc = undefined;
    await new Promise<void>((resolve) => { p.once("exit", () => resolve()); p.kill("SIGKILL"); });
  }
}
