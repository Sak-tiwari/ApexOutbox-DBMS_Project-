import PDFDocument from "pdfkit";
import { formatMoney, type PricedLine } from "./money.js";

/** Everything the PDF shows. Frozen into invoices.snapshot at issue time, so later edits never alter an issued invoice. */
export interface InvoiceSnapshot {
  number: string;
  issuedAt: string;
  dueAt: string | null;
  currency: string;
  seller: { name: string };
  client: {
    name: string;
    company: string | null;
    email: string;
    phone: string | null;
    taxId: string | null;
    billingAddress: Record<string, string>;
  };
  items: PricedLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

// Standard PDF fonts only cover Latin-1; anything else would print as garbage, so show "?" instead.
const latin = (s: string) => s.replace(/[^\u0009\u000a -~ -ÿ]/g, "?");
const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export function renderInvoicePdf(s: InvoiceSnapshot): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      info: { Title: `Invoice ${s.number}`, Author: latin(s.seller.name), CreationDate: new Date(s.issuedAt) },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(22).font("Helvetica-Bold").text(latin(s.seller.name), 50, 50, { width: 300 });
    doc.fontSize(24).text("INVOICE", 350, 50, { width: 195, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor("#444");
    doc.text(`Number: ${s.number}`, 350, 82, { width: 195, align: "right" });
    doc.text(`Issued: ${date(s.issuedAt)}`, { width: 195, align: "right" });
    if (s.dueAt) doc.text(`Due: ${date(s.dueAt)}`, { width: 195, align: "right" });

    doc.fillColor("#000").font("Helvetica-Bold").fontSize(10).text("BILL TO", 50, 140);
    doc.font("Helvetica").fontSize(11);
    const c = s.client;
    doc.text(latin(c.name));
    if (c.company && c.company !== c.name) doc.text(latin(c.company));
    const addr = c.billingAddress;
    for (const k of ["line1", "line2"]) if (addr[k]) doc.text(latin(addr[k]!));
    const cityLine = [addr.city, addr.state, addr.postalCode].filter(Boolean).join(", ");
    if (cityLine) doc.text(latin(cityLine));
    if (addr.country) doc.text(latin(addr.country));
    doc.text(latin(c.email));
    if (c.phone) doc.text(latin(c.phone));
    if (c.taxId) doc.text(`Tax ID: ${latin(c.taxId)}`);

    // Items table
    let y = Math.max(doc.y + 24, 260);
    const col = { desc: 50, qty: 300, unit: 355, tax: 440, amt: 480 };
    doc.font("Helvetica-Bold").fontSize(9);
    doc.text("DESCRIPTION", col.desc, y).text("QTY", col.qty, y, { width: 50, align: "right" }).text("UNIT", col.unit, y, { width: 80, align: "right" }).text("TAX", col.tax, y, { width: 35, align: "right" }).text("AMOUNT", col.amt, y, { width: 65, align: "right" });
    y += 16;
    doc.moveTo(50, y - 4).lineTo(545, y - 4).strokeColor("#999").stroke();
    doc.font("Helvetica").fontSize(10);
    for (const it of s.items) {
      const h = doc.heightOfString(latin(it.description), { width: 240 });
      if (y + h > 740) { doc.addPage(); y = 60; }
      doc.text(latin(it.description), col.desc, y, { width: 240 });
      doc.text(String(it.quantity), col.qty, y, { width: 50, align: "right" });
      doc.text(formatMoney(it.unitAmountMinor, s.currency).replace(`${s.currency} `, ""), col.unit, y, { width: 80, align: "right" });
      doc.text(`${it.taxRateBp / 100}%`, col.tax, y, { width: 35, align: "right" });
      doc.text(formatMoney(it.subtotalMinor, s.currency).replace(`${s.currency} `, ""), col.amt, y, { width: 65, align: "right" });
      y += Math.max(h, 12) + 8;
    }
    if (y > 680) { doc.addPage(); y = 60; }
    doc.moveTo(300, y).lineTo(545, y).strokeColor("#999").stroke();
    y += 10;
    const row = (label: string, value: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 12 : 10);
      doc.text(label, 300, y, { width: 120 }).text(value, 420, y, { width: 125, align: "right" });
      y += bold ? 20 : 16;
    };
    row("Subtotal", formatMoney(s.subtotalMinor, s.currency));
    row("Tax", formatMoney(s.taxMinor, s.currency));
    row("Total", formatMoney(s.totalMinor, s.currency), true);

    doc.font("Helvetica").fontSize(9).fillColor("#666").text("Thank you for your business.", 50, 780, { width: 495, align: "center" });
    doc.end();
  });
}
