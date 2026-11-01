"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvoiceNotFoundError = void 0;
exports.processInvoiceJob = processInvoiceJob;
const email_1 = require("./email");
class InvoiceNotFoundError extends Error {
    constructor(id) {
        super(`Invoice not found: ${id}`);
        this.name = "InvoiceNotFoundError";
    }
}
exports.InvoiceNotFoundError = InvoiceNotFoundError;
/**
 * Processes one invoice: make the PDF, then send the email AT MOST ONCE.
 *
 * Why "at most once": a retry after a crash or timeout that blindly re-sends can deliver the same
 * invoice twice. So before sending we durably record EMAIL_SENDING (atomic claim). If we later find
 * an old EMAIL_SENDING marker, or the provider call ends in an unknown state, the invoice becomes
 * EMAIL_UNCERTAIN and waits for a human/reconciler. Only failures that definitely did NOT send
 * (EMAIL_FAILED) are retried automatically. The BullMQ job rethrows only those.
 */
async function processInvoiceJob(invoiceId, deps) {
    const { store, generatePdf, sendEmail, log } = deps;
    const now = deps.now ?? (() => new Date());
    const staleMs = deps.staleSendingMs ?? 5 * 60_000;
    const invoice = await store.findById(invoiceId);
    if (!invoice)
        throw new InvoiceNotFoundError(invoiceId);
    if (invoice.status === "EMAIL_SENT")
        return { outcome: "skipped", reason: "already-sent" };
    if (invoice.status === "EMAIL_ABANDONED")
        return { outcome: "skipped", reason: "abandoned" };
    if (invoice.status === "EMAIL_UNCERTAIN")
        return { outcome: "skipped", reason: "uncertain-needs-manual-check" };
    if (invoice.status === "EMAIL_SENDING") {
        if (now().getTime() - invoice.updatedAt.getTime() < staleMs) {
            return { outcome: "skipped", reason: "in-progress" };
        }
        // The previous attempt started sending and never reported back. It may have been delivered.
        const reason = "Previous send attempt did not finish; delivery status unknown";
        await store.markUncertain(invoiceId, reason);
        log.error({ invoiceId, invoiceNumber: invoice.invoiceNumber }, "ALERT invoice email outcome uncertain (stale EMAIL_SENDING)");
        return { outcome: "uncertain", reason };
    }
    const maxAttempts = deps.maxEmailAttempts ?? 5;
    if (invoice.status === "EMAIL_FAILED" && invoice.emailAttempts >= maxAttempts) {
        const reason = `Gave up after ${invoice.emailAttempts} failed sends: ${invoice.lastError}`;
        await store.markAbandoned(invoiceId, reason);
        log.error({ invoiceId, invoiceNumber: invoice.invoiceNumber }, "ALERT invoice email abandoned after repeated failures");
        return { outcome: "abandoned", reason };
    }
    let pdfPath = invoice.pdfPath;
    if (!pdfPath)
        pdfPath = await generatePdf(invoice.invoiceNumber, invoice.snapshot);
    // Always (re)record the path: it is idempotent, and repairs an invoice left PENDING with a path.
    if (invoice.status === "PENDING" || !invoice.pdfPath)
        await store.setPdf(invoiceId, pdfPath);
    const claimed = await store.claimForSending(invoiceId);
    if (!claimed)
        return { outcome: "skipped", reason: "lost-claim" };
    try {
        const result = await sendEmail({
            to: claimed.snapshot.email,
            clientName: claimed.snapshot.clientName,
            invoiceNumber: claimed.invoiceNumber,
            pdfPath
        });
        await store.markSent(invoiceId, result.messageId);
        log.info({ invoiceId, messageId: result.messageId, demo: result.demo }, "invoice email sent");
        return { outcome: "sent", messageId: result.messageId, demo: result.demo };
    }
    catch (error) {
        if (error instanceof email_1.EmailUncertainError) {
            await store.markUncertain(invoiceId, String(error));
            log.error({ invoiceId, invoiceNumber: claimed.invoiceNumber, error: String(error) }, "ALERT invoice email outcome uncertain; not retrying automatically");
            return { outcome: "uncertain", reason: String(error) };
        }
        if (error instanceof email_1.EmailPermanentError) {
            await store.markAbandoned(invoiceId, String(error));
            log.error({ invoiceId, invoiceNumber: claimed.invoiceNumber, error: String(error) }, "ALERT invoice email permanently rejected; not retrying");
            return { outcome: "abandoned", reason: String(error) };
        }
        await store.markFailed(invoiceId, String(error));
        log.warn({ invoiceId, error: String(error) }, "invoice email failed; will retry");
        throw error;
    }
}
//# sourceMappingURL=processor.js.map