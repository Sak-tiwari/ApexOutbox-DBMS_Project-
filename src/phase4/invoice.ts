import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { InvoiceSnapshot } from "./types";

export async function generateInvoicePDF(
  invoiceNumber: string,
  snapshot: InvoiceSnapshot,
  directoryName: string = process.env.INVOICE_DIR || "generated-invoices"
): Promise<string> {
  // Defence in depth: the number is server-generated, but it ends up in a file name.
  if (!/^[A-Za-z0-9_-]+$/.test(invoiceNumber)) {
    throw new Error("Invalid invoice number for file name");
  }

  const directory = path.resolve(directoryName);
  fs.mkdirSync(directory, { recursive: true });

  const filePath = path.join(directory, `${invoiceNumber}.pdf`);
  // Write to a temp file and rename, so a crash can never leave a half-written PDF at the final path.
  // Unique per call: two workers (or two concurrent jobs) may build the same invoice at once.
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const createdAt = new Date(snapshot.createdAt);

  try {
    await new Promise<void>((resolve, reject) => {
      const pdf = new PDFDocument({ margin: 50 });
      const output = fs.createWriteStream(tempPath);

      output.on("finish", resolve);
      output.on("error", reject);
      pdf.on("error", reject);
      pdf.pipe(output);

      pdf.fontSize(24).text("INVOICE", { align: "right" });
      pdf.moveDown();

      pdf.fontSize(12).text(`Invoice Number: ${invoiceNumber}`);
      pdf.text(`Date: ${createdAt.toLocaleDateString("en-IN")}`);

      pdf.moveDown();
      pdf.text(`Client: ${snapshot.clientName}`);
      pdf.text(`Email: ${snapshot.email}`);
      pdf.text(`Company: ${snapshot.company || "N/A"}`);

      pdf.moveDown();
      pdf.text(`Description: ${snapshot.description}`);

      pdf.moveDown();
      pdf.fontSize(18).text(`Total: ${snapshot.currency} ${snapshot.amount.toFixed(2)}`);

      pdf.end();
    });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }

  return filePath;
}
