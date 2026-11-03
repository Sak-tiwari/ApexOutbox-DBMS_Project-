import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isUuid } from "../db/pool.js";

/**
 * Invoice PDFs on local disk, one file per invoice at <dir>/<tenantId>/<invoiceId>.pdf.
 * File names come only from database uuids (checked here), so a path can never be steered outside the directory.
 * The sha256 stored in the database lets a download detect a file that was altered or corrupted.
 */
export class InvoiceStorage {
  private readonly base: string;
  constructor(dir: string) {
    this.base = path.resolve(dir);
  }

  keyFor(tenantId: string, invoiceId: string): string {
    if (!isUuid(tenantId) || !isUuid(invoiceId)) throw new Error("Invalid invoice key");
    return `${tenantId}/${invoiceId}.pdf`;
  }

  private resolve(key: string): string {
    const full = path.resolve(this.base, key);
    if (!full.startsWith(this.base + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  async save(key: string, bytes: Buffer): Promise<string> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, bytes, { flag: "wx" });
      await rename(tmp, target); // atomic: a crash never leaves a half-written PDF at the final path
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return createHash("sha256").update(bytes).digest("hex");
  }

  /** Returns the bytes, or null when missing or when they no longer match the recorded hash. */
  async read(key: string, expectedSha256?: string | null): Promise<Buffer | null> {
    try {
      const bytes = await readFile(this.resolve(key));
      if (expectedSha256 && createHash("sha256").update(bytes).digest("hex") !== expectedSha256) return null;
      return bytes;
    } catch {
      return null;
    }
  }
}
