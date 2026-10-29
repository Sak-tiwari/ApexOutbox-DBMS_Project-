
import { z } from "zod";

export const onboardingSchema = z.object({
  leadId: z.string().trim().min(1),
  clientName: z.string().trim().min(1),
  email: z.string().email(),
  company: z.string().optional().default(""),
  amount: z.number().finite().nonnegative(),
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
