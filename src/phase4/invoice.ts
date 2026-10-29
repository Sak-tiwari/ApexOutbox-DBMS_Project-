
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { InvoiceSnapshot } from "./types";

export async function generateInvoicePDF(
  invoiceNumber: string,
  snapshot: InvoiceSnapshot
): Promise<string> {
  const directory = path.resolve("generated-invoices");

  fs.mkdirSync(directory, { recursive: true });

  const filePath = path.join(
    directory,
    `${invoiceNumber}.pdf`
  );

  await new Promise<void>((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 50 });
    const output = fs.createWriteStream(filePath);

    output.on("finish", resolve);
    output.on("error", reject);
    pdf.on("error", reject);

    pdf.fontSize(24).text("INVOICE", { align: "right" });
    pdf.moveDown();

    pdf.fontSize(12).text(`Invoice Number: ${invoiceNumber}`);
    pdf.text(
      `Date: ${snapshot.createdAt.toLocaleDateString("en-IN")}`
    );

    pdf.moveDown();
    pdf.text(`Client: ${snapshot.clientName}`);
    pdf.text(`Email: ${snapshot.email}`);
    pdf.text(`Company: ${snapshot.company || "N/A"}`);

    pdf.moveDown();
    pdf.text(`Description: ${snapshot.description}`);

    pdf.moveDown();
    pdf.fontSize(18).text(
      `Total: ${snapshot.currency} ${snapshot.amount.toFixed(2)}`
    );

    pdf.end();
  });

  return filePath;
}
