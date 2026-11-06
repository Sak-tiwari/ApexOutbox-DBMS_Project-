import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateInvoicePDF } from "../phase4/invoice";
import type { Log } from "../phase4/ports";
import type { InvoiceSnapshot } from "../phase4/types";
import { builtinVersionId, FALLBACK_ID } from "./builtins";
import { renderTemplateHtml } from "./engine";
import { htmlToPdf } from "./renderer";
import type { InvoiceTemplateStore, Renderable } from "./store";
import { buildViewData, type ViewData } from "./viewModel";

export interface PdfDeps { store: InvoiceTemplateStore; invoiceDir: string; log: Log; toPdf?: (html: string) => Promise<Buffer> }

/** Template data for one invoice: business logo/QR and the user's assets become data: URIs. */
export async function viewDataFor(store: InvoiceTemplateStore, snapshot: InvoiceSnapshot, number: string, r?: Renderable, status?: string): Promise<{ data: ViewData; assets: Record<string, string> }> {
  const owner = snapshot.ownerId;
  const [logo, qr, assets] = owner
    ? await Promise.all([store.dataUriFor(owner, snapshot.business?.logoAssetId ?? ""), store.dataUriFor(owner, snapshot.business?.qrAssetId ?? ""), store.assetDataUris(owner)])
    : ["", "", {}];
  let s = snapshot;
  if (r?.overrides && s.business) {
    const o = Object.fromEntries(Object.entries(r.overrides).filter(([, v]) => typeof v === "string" && v.trim() !== ""));
    s = { ...s, business: { ...s.business, ...o } };
  }
  return { data: buildViewData(s, { number, status, images: { logo, qr }, brand: r?.brand }), assets };
}

export async function renderHtmlFor(store: InvoiceTemplateStore, snapshot: InvoiceSnapshot, number: string, versionId: string, status?: string): Promise<string> {
  const r = await store.renderable(versionId, snapshot.ownerId);
  const { data, assets } = await viewDataFor(store, snapshot, number, r, status);
  return renderTemplateHtml(r.source, data, assets);
}

function writeAtomically(dir: string, invoiceNumber: string, pdf: Buffer): string {
  if (!/^[A-Za-z0-9_-]+$/.test(invoiceNumber)) throw new Error("Invalid invoice number for file name");
  const d = path.resolve(dir);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `${invoiceNumber}.pdf`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, pdf); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  return file;
}

/**
 * Makes the invoice PDF. Never lets a bad template stop an invoice:
 *   1. the template version recorded on the invoice (Chromium)
 *   2. if that fails: the built-in Standard template (Chromium), with a warning in the log
 *   3. if Chromium itself is unavailable: the original PDFKit invoice
 * Invoices made before templates existed (no templateVersionId) keep the original PDFKit design.
 */
export async function generateInvoicePdfWithTemplate(invoiceNumber: string, snapshot: InvoiceSnapshot, deps: PdfDeps): Promise<{ path: string; usedVersionId: string; fallback: boolean }> {
  const toPdf = deps.toPdf ?? ((h: string) => htmlToPdf(h));
  if (!snapshot.templateVersionId) return { path: await generateInvoicePDF(invoiceNumber, snapshot, deps.invoiceDir), usedVersionId: "legacy", fallback: false };
  try {
    const html = await renderHtmlFor(deps.store, snapshot, invoiceNumber, snapshot.templateVersionId);
    return { path: writeAtomically(deps.invoiceDir, invoiceNumber, await toPdf(html)), usedVersionId: snapshot.templateVersionId, fallback: false };
  } catch (error) {
    deps.log.warn({ invoiceNumber, templateVersionId: snapshot.templateVersionId, error: String(error).slice(0, 300) }, "invoice template failed; using the built-in template");
  }
  const fallbackId = builtinVersionId(FALLBACK_ID);
  try {
    const html = await renderHtmlFor(deps.store, snapshot, invoiceNumber, fallbackId);
    return { path: writeAtomically(deps.invoiceDir, invoiceNumber, await toPdf(html)), usedVersionId: fallbackId, fallback: true };
  } catch (error) {
    deps.log.warn({ invoiceNumber, error: String(error).slice(0, 300) }, "built-in HTML template failed too (is Chromium installed?); using the basic PDF");
    return { path: await generateInvoicePDF(invoiceNumber, snapshot, deps.invoiceDir), usedVersionId: "legacy", fallback: true };
  }
}
