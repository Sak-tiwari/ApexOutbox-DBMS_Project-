import { validateOnboarding } from "../phase4/onboarding";
import type { OnboardingInput, OnboardingResult } from "../phase4/onboardingService";
import type { Log } from "../phase4/ports";
import type { LeadRecord, LeadStore } from "../stores/types";

export type OnboardFn = (data: OnboardingInput) => Promise<OnboardingResult>;

export const MAX_ONBOARDING_ATTEMPTS = 10;

/**
 * Closed-Won -> Phase 4 hand-off.
 *
 * The transition already stored `deal` and `onboardingStatus = PENDING` in the SAME single-document
 * update as the state change, so the intent to onboard can never be lost. This function then tries
 * to do the onboarding straight away. If that fails (database blip, crash), the lead simply stays
 * PENDING and `reconcileOnboarding` retries it. Retrying is safe because `onboardClient` is
 * idempotent per lead.
 */
export async function attemptOnboarding(
  lead: LeadRecord,
  deps: { leads: LeadStore; onboard: OnboardFn; log: Log },
): Promise<"DONE" | "PENDING" | "FAILED" | "CANCELLED"> {
  const { leads, onboard, log } = deps;
  if (lead.currentState !== "Closed-Won" || !lead.deal) return lead.onboardingStatus ?? "PENDING";
  if (lead.onboardingStatus === "DONE") return "DONE";

  const parsed = validateOnboarding({
    leadId: lead.id,
    clientName: lead.name,
    email: lead.deal.email,
    company: lead.company,
    amount: lead.deal.amount,
    currency: lead.deal.currency,
    description: lead.deal.description,
    ownerId: lead.ownerId,
    invoiceNumber: lead.deal.invoiceNumber,
    businessGstin: lead.deal.businessGstin,
    clientGstin: lead.deal.clientGstin,
    clientAddress: lead.deal.clientAddress,
    clientState: lead.deal.clientState,
    gstRate: lead.deal.gstRate,
    templateId: lead.deal.templateId,
  });

  if (!parsed.success) {
    // Bad data will not fix itself on retry: stop and make it visible.
    await leads.markOnboarding(lead.id, "FAILED", `Invalid deal data: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    log.error({ leadId: lead.id }, "ALERT onboarding data invalid; lead needs manual attention");
    return "FAILED";
  }

  try {
    await onboard(parsed.data);
    await leads.markOnboarding(lead.id, "DONE");
    return "DONE";
  } catch (error) {
    const exhausted = lead.onboardingAttempts + 1 >= MAX_ONBOARDING_ATTEMPTS;
    await leads.markOnboarding(lead.id, exhausted ? "FAILED" : "PENDING", String(error));
    if (exhausted) log.error({ leadId: lead.id, error: String(error) }, "ALERT onboarding permanently failed");
    else log.warn({ leadId: lead.id, error: String(error) }, "onboarding failed; reconciler will retry");
    return exhausted ? "FAILED" : "PENDING";
  }
}

/** Retries every Closed-Won lead whose hand-off has not completed. Run periodically by the worker. */
export async function reconcileOnboarding(
  deps: { leads: LeadStore; onboard: OnboardFn; log: Log },
  batch = 20,
): Promise<{ done: number; stillPending: number; failed: number }> {
  const pending = await deps.leads.findOnboardingPending(batch);
  const tally = { done: 0, stillPending: 0, failed: 0 };
  for (const lead of pending) {
    const status = await attemptOnboarding(lead, deps);
    if (status === "DONE") tally.done++;
    else if (status === "FAILED") tally.failed++;
    else tally.stillPending++;
  }
  return tally;
}
