import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateInvoicePDF } from "../../src/phase4/invoice";

const snap = { clientName: "Asha", email: "asha@example.com", company: "Acme", amount: 1234.5, currency: "INR", description: "Website build", createdAt: new Date() };

describe("invoice PDF", () => {
  it("finishes and writes a real PDF (regression: the original never piped output and hung forever)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-"));
    const file = await Promise.race([
      generateInvoicePDF("INV-abc123", snap, dir),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("generateInvoicePDF hung")), 5000)),
    ]);
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(500);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(bytes.toString("latin1")).toContain("%%EOF");
  });

  it("accepts a createdAt that came back as a string (e.g. after JSON)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-"));
    await expect(generateInvoicePDF("INV-str", { ...snap, createdAt: new Date().toISOString() as unknown as Date }, dir)).resolves.toBeTruthy();
  });

  it("rejects an invoice number that could escape the folder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-"));
    await expect(generateInvoicePDF("../../etc/passwd", snap, dir)).rejects.toThrow(/Invalid invoice number/);
  });
});
