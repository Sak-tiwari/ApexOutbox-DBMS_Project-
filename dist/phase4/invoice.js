"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateInvoicePDF = generateInvoicePDF;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const pdfkit_1 = __importDefault(require("pdfkit"));
async function generateInvoicePDF(invoiceNumber, snapshot, directoryName = process.env.INVOICE_DIR || "generated-invoices") {
    // Defence in depth: the number is server-generated, but it ends up in a file name.
    if (!/^[A-Za-z0-9_-]+$/.test(invoiceNumber)) {
        throw new Error("Invalid invoice number for file name");
    }
    const directory = node_path_1.default.resolve(directoryName);
    node_fs_1.default.mkdirSync(directory, { recursive: true });
    const filePath = node_path_1.default.join(directory, `${invoiceNumber}.pdf`);
    // Write to a temp file and rename, so a crash can never leave a half-written PDF at the final path.
    // Unique per call: two workers (or two concurrent jobs) may build the same invoice at once.
    const tempPath = `${filePath}.${(0, node_crypto_1.randomUUID)()}.tmp`;
    const createdAt = new Date(snapshot.createdAt);
    try {
        await new Promise((resolve, reject) => {
            const pdf = new pdfkit_1.default({ margin: 50 });
            const output = node_fs_1.default.createWriteStream(tempPath);
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
        node_fs_1.default.renameSync(tempPath, filePath);
    }
    catch (error) {
        node_fs_1.default.rmSync(tempPath, { force: true });
        throw error;
    }
    return filePath;
}
//# sourceMappingURL=invoice.js.map