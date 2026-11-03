import { describe, expect, it } from "vitest";
import { attemptOnboarding, MAX_ONBOARDING_ATTEMPTS, reconcileOnboarding } from "../../src/services/onboardingHandoff";
import { silentLog } from "../../src/phase4/ports";
import { MemoryLeadStore } from "../helpers/memory";

const wonLead = (store: MemoryLeadStore, id = "L1", extra = {}) =>
  store.seed({ id, currentState: "Closed-Won", onboardingStatus: "PENDING", deal: { email: "asha@example.com", amount: 5000, currency: "INR", description: "Build" }, ...extra });

const okOnboard = (calls: any[]) => async (d: any) => { calls.push(d); return { clientId: "c", invoiceId: "i", invoiceNumber: "INV-1", status: "PENDING" }; };

describe("Closed-Won hand-off to onboarding", () => {
  it("onboards with the lead's name/company and the deal, then marks DONE", async () => {
    const leads = new MemoryLeadStore(); wonLead(leads);
    const calls: any[] = [];
    const status = await attemptOnboarding((await leads.findById("L1"))!, { leads, onboard: okOnboard(calls), log: silentLog });
    expect(status).toBe("DONE");
    expect(calls[0]).toMatchObject({ leadId: "L1", clientName: "Acme Lead", company: "Acme", email: "asha@example.com", amount: 5000, currency: "INR" });
    expect(leads.leads.get("L1")!.onboardingStatus).toBe("DONE");
  });

  it("a failure keeps the lead PENDING with the error, and the reconciler finishes it later", async () => {
    const leads = new MemoryLeadStore(); wonLead(leads);
    let healthy = false; const calls: any[] = [];
    const onboard = async (d: any) => { if (!healthy) throw new Error("mongo blip"); return okOnboard(calls)(d); };
    expect(await attemptOnboarding((await leads.findById("L1"))!, { leads, onboard, log: silentLog })).toBe("PENDING");
    expect(leads.leads.get("L1")!.onboardingError).toMatch(/mongo blip/);
    healthy = true;
    expect(await reconcileOnboarding({ leads, onboard, log: silentLog })).toEqual({ done: 1, stillPending: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(await reconcileOnboarding({ leads, onboard, log: silentLog })).toEqual({ done: 0, stillPending: 0, failed: 0 });
  });

  it("gives up after the maximum attempts and marks FAILED for manual attention", async () => {
    const leads = new MemoryLeadStore(); wonLead(leads);
    const onboard = async () => { throw new Error("still broken"); };
    let last = "";
    for (let i = 0; i < MAX_ONBOARDING_ATTEMPTS; i++) last = await attemptOnboarding((await leads.findById("L1"))!, { leads, onboard, log: silentLog });
    expect(last).toBe("FAILED");
    expect(await leads.findOnboardingPending(10)).toHaveLength(0);
  });

  it("invalid deal data is FAILED immediately (retrying cannot fix it)", async () => {
    const leads = new MemoryLeadStore(); wonLead(leads, "L1", { deal: { email: "not-an-email", amount: 10, currency: "INR", description: "x" } });
    let called = false;
    const s = await attemptOnboarding((await leads.findById("L1"))!, { leads, onboard: async () => { called = true; return null as any; }, log: silentLog });
    expect(s).toBe("FAILED");
    expect(called).toBe(false);
  });

  it("does nothing for a lead that is not Closed-Won or is already DONE", async () => {
    const leads = new MemoryLeadStore(); const calls: any[] = [];
    leads.seed({ id: "N", currentState: "Negotiation" });
    wonLead(leads, "D", { onboardingStatus: "DONE" });
    await attemptOnboarding((await leads.findById("N"))!, { leads, onboard: okOnboard(calls), log: silentLog });
    await attemptOnboarding((await leads.findById("D"))!, { leads, onboard: okOnboard(calls), log: silentLog });
    expect(calls).toHaveLength(0);
  });
});
