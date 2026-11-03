
import { z } from "zod";

export const onboardingSchema = z.object({
  leadId: z.string().trim().min(1),
  clientName: z.string().trim().min(1),
  email: z.string().email(),
  company: z.string().optional().default(""),
  // Money: at most 2 decimal places (paise). Rejects 10.005 and similar rounding traps.
  amount: z
    .number()
    .finite()
    .nonnegative()
    .max(100_000_000)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "amount must have at most 2 decimal places"),
  currency: z.string().length(3).default("INR"),
  description: z.string().trim().min(1)
});

export function getInvoiceIdempotencyKey(
  leadId: string
): string {
  return `lead:${leadId}:initial-invoice`;
}

export function validateOnboarding(input: unknown) {
  return onboardingSchema.safeParse(input);
}
