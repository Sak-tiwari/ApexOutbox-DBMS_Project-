"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardingSchema = void 0;
exports.getInvoiceIdempotencyKey = getInvoiceIdempotencyKey;
exports.validateOnboarding = validateOnboarding;
const zod_1 = require("zod");
exports.onboardingSchema = zod_1.z.object({
    leadId: zod_1.z.string().trim().min(1),
    clientName: zod_1.z.string().trim().min(1),
    email: zod_1.z.string().email(),
    company: zod_1.z.string().optional().default(""),
    // Money: at most 2 decimal places (paise). Rejects 10.005 and similar rounding traps.
    amount: zod_1.z
        .number()
        .finite()
        .nonnegative()
        .max(100_000_000)
        .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "amount must have at most 2 decimal places"),
    currency: zod_1.z.string().length(3).default("INR"),
    description: zod_1.z.string().trim().min(1)
});
function getInvoiceIdempotencyKey(leadId) {
    return `lead:${leadId}:initial-invoice`;
}
function validateOnboarding(input) {
    return exports.onboardingSchema.safeParse(input);
}
//# sourceMappingURL=onboarding.js.map