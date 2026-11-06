import type { InvoiceSnapshot } from "../phase4/types";
import { computeTotals } from "./gst";
import { amountInWords, formatMoney } from "./money";

export interface BrandOptions { color: string; font: string; cols: { qty: boolean; rate: boolean; tax: boolean }; footer: string; terms?: string }
export const DEFAULT_BRAND: BrandOptions = { color: "#4f46e5", font: "Helvetica, Arial, sans-serif", cols: { qty: true, rate: true, tax: true }, footer: "Thank you for your business." };

export type ViewData = Record<string, unknown>;

const fmtDate = (d?: Date | string) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "");
const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

/**
 * Turns an invoice snapshot into the template data. Works for old invoices too (no business, items or tax):
 * the deal becomes one line item and the amount is the total.
 * `images` holds data: URIs for the logo and QR (the renderer never loads anything from the network).
 */
export function buildViewData(s: InvoiceSnapshot, opts: { number: string; status?: string; images?: { logo?: string; qr?: string }; brand?: BrandOptions } ): ViewData {
  const currency = s.currency || "INR";
  const m = (n: number) => formatMoney(n, currency);
  const b = s.business;
  const rate = s.gstRate ?? 0;
  const items = s.items?.length ? s.items : [{ description: s.description, qty: 1, rate: s.amount, taxRate: 0, amount: s.amount }];
  const totals = s.totals ?? computeTotals(items, rate, { gstin: b?.gstin, state: b?.state }, { gstin: s.clientGstin, state: s.clientState });
  const brand = opts.brand ?? DEFAULT_BRAND;
  const intra = totals.mode === "intra", inter = totals.mode === "inter";
  return {
    business: { name: b?.name ?? "", logo: opts.images?.logo ?? "", address: b?.address ?? "", gstin: b?.gstin ?? "", state: b?.state ?? "", email: b?.email ?? "", phone: b?.phone ?? "" },
    client: { name: s.clientName, company: s.company ?? "", address: s.clientAddress ?? "", gstin: s.clientGstin ?? "", state: s.clientState ?? b?.state ?? "", email: s.email },
    invoice: { number: s.displayNumber || opts.number, date: fmtDate(s.createdAt), due_date: fmtDate(s.dueDate), currency, status: opts.status ?? "", is_paid: /^paid$/i.test(opts.status ?? ""), notes: "" },
    items: items.map((i, idx) => ({ no: idx + 1, description: i.description, qty: String(i.qty), rate: m(i.rate), tax_rate: pct(i.taxRate), amount: m(i.amount) })),
    totals: { subtotal: m(totals.subtotal), discount: m(totals.discount), cgst: m(totals.cgst), sgst: m(totals.sgst), igst: m(totals.igst), total: m(totals.total), amount_in_words: amountInWords(totals.total, currency), has_discount: totals.discount > 0 },
    tax: { is_intra: intra, is_inter: inter, rate: pct(rate), cgst_rate: pct(intra ? rate / 2 : 0), sgst_rate: pct(intra ? rate / 2 : 0), igst_rate: pct(inter ? rate : 0), label: intra ? "CGST + SGST" : inter ? "IGST" : "No GST" },
    payment: { bank_name: b?.bankName ?? "", account: b?.account ?? "", ifsc: b?.ifsc ?? "", upi_id: b?.upiId ?? "", qr: opts.images?.qr ?? "", link: b?.paymentLink ?? "", has_bank: !!(b?.bankName && b?.account) },
    brand: { color: brand.color, font: brand.font },
    cols: brand.cols,
    doc: { footer: brand.footer, terms: brand.terms ?? b?.terms ?? "" },
  };
}

/** Realistic sample invoice for previews before any real invoice exists. */
export function sampleSnapshot(): InvoiceSnapshot {
  const items = [
    { description: "Website design and development (5 pages)", qty: 1, rate: 45000, taxRate: 18, amount: 45000 },
    { description: "Shopify store setup", qty: 1, rate: 25000, taxRate: 18, amount: 25000 },
    { description: "Monthly maintenance", qty: 3, rate: 3000, taxRate: 18, amount: 9000 },
  ];
  const business = { name: "Apex Web Studio", address: "12 MG Road, Pune, Maharashtra 411001", gstin: "27ABCDE1234F1Z5", state: "Maharashtra", email: "hello@apexweb.test", phone: "+91 98765 43210", logoAssetId: "", bankName: "HDFC Bank", account: "50100123456789", ifsc: "HDFC0001234", upiId: "apexweb@hdfc", paymentLink: "https://pay.example.com/apex", qrAssetId: "", terms: "Payment due within 15 days." };
  const totals = computeTotals(items, 18, business, { gstin: "27PQRSX6789K1Z2" });
  return {
    clientName: "Greenleaf Organics", email: "accounts@greenleaf.test", company: "Greenleaf Organics Pvt Ltd", amount: totals.total, currency: "INR",
    description: items[0].description, createdAt: new Date(), dueDate: new Date(Date.now() + 15 * 86_400_000), displayNumber: "INV/2026/0042",
    business, clientAddress: "4 Baner Road, Pune 411045", clientState: "Maharashtra", clientGstin: "27PQRSX6789K1Z2", items, gstRate: 18, totals,
  };
}
