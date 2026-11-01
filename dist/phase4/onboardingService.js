"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardClient = onboardClient;
const mongoose_1 = __importDefault(require("mongoose"));
const models_1 = require("./models");
const onboarding_1 = require("./onboarding");
const outbox_1 = require("./outbox");
const isDuplicateKey = (e) => e?.code === 11000;
/**
 * Create-or-get ONE client and ONE invoice for a lead, then make sure an outbox event exists.
 * Safe to call any number of times, concurrently, for the same lead:
 *   - client:  unique index on sourceLeadId
 *   - invoice: unique index on idempotencyKey ("lead:<id>:initial-invoice")
 *   - event:   unique index on eventId ("invoice-created:<invoiceId>")
 * (Extracted unchanged in behaviour from the Phase 4 route handler, plus handling of the
 * duplicate-key error that a concurrent client upsert can raise.)
 */
async function onboardClient(data) {
    const idempotencyKey = (0, onboarding_1.getInvoiceIdempotencyKey)(data.leadId);
    let invoice = await models_1.Invoice.findOne({ idempotencyKey });
    if (!invoice) {
        let client;
        try {
            client = await models_1.Client.findOneAndUpdate({ sourceLeadId: data.leadId }, { $setOnInsert: { sourceLeadId: data.leadId, name: data.clientName, email: data.email, company: data.company || "" } }, { upsert: true, new: true });
        }
        catch (error) {
            // Two concurrent upserts can both try to insert; the loser gets E11000. The row exists now.
            if (!isDuplicateKey(error))
                throw error;
            client = await models_1.Client.findOne({ sourceLeadId: data.leadId });
        }
        if (!client)
            throw new Error("Client could not be created or found");
        try {
            invoice = await models_1.Invoice.create({
                idempotencyKey,
                invoiceNumber: `INV-${new mongoose_1.default.Types.ObjectId().toString()}`,
                clientId: client._id,
                snapshot: {
                    clientName: data.clientName,
                    email: data.email,
                    company: data.company || "",
                    amount: data.amount,
                    currency: data.currency,
                    description: data.description,
                    createdAt: new Date()
                },
                status: "PENDING"
            });
        }
        catch (error) {
            // A duplicate request may have created the invoice first.
            invoice = await models_1.Invoice.findOne({ idempotencyKey });
            if (!invoice)
                throw error;
        }
    }
    if (invoice.status === "PENDING") {
        await (0, outbox_1.recordOnboardingEvent)(String(invoice._id));
    }
    return {
        clientId: String(invoice.clientId),
        invoiceId: String(invoice._id),
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status
    };
}
//# sourceMappingURL=onboardingService.js.map