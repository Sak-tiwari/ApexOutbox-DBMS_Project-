import { describe, expect, it } from "vitest";
import { ALLOWED_TRANSITIONS, TransitionService } from "../../src/services/TransitionService";
import { AppError } from "../../src/errors";
import { MemoryLeadStore } from "../helpers/memory";

const deal = { email: "asha@example.com", amount: 5000, currency: "INR", description: "Website build" };
const make = () => { const store = new MemoryLeadStore(); store.seed({ id: "L1" }); return { store, svc: new TransitionService(store) }; };
const go = (svc: TransitionService, to: any, version: number, extra: object = {}) => svc.transitionLead({ leadId: "L1", targetState: to, actorId: "userA", expectedVersion: version, ...extra });
const code = async (p: Promise<unknown>) => (await p.catch((e) => e)) as AppError;

describe("pipeline transitions", () => {
  it("moves a lead forward and writes an audit entry (Phase 3 test 1)", async () => {
    const { svc } = make();
    const l = await go(svc, "Contacted", 0);
    expect(l.currentState).toBe("Contacted");
    expect(l.version).toBe(1);
    expect(l.activityHistory).toHaveLength(1);
    expect(l.activityHistory[0]).toMatchObject({ fromState: "New", toState: "Contacted", changedBy: "userA" });
  });

  it("blocks illegal jumps with 422 and lists the allowed targets (Phase 3 test 2)", async () => {
    const { svc } = make();
    await go(svc, "Contacted", 0);
    const e = await code(go(svc, "Closed-Won", 1, { deal }));
    expect(e.status).toBe(422);
    expect(e.code).toBe("INVALID_TRANSITION");
    expect(e.message).toContain("Invalid Pipeline Transition");
    expect((e.details as any).allowed).toEqual(ALLOWED_TRANSITIONS["Contacted"]);
  });

  it("requires a reason to reopen a closed lead (Phase 3 test 3)", async () => {
    const { store, svc } = make();
    store.leads.get("L1")!.currentState = "Closed-Lost";
    const e = await code(go(svc, "New", 0));
    expect([e.status, e.code]).toEqual([422, "REASON_REQUIRED"]);
    expect(e.message).toContain("Reopening Guard");
    expect((await go(svc, "New", 0, { reason: "Client called back" })).currentState).toBe("New");
  });

  it("rejects a stale version with 409 (Phase 3 test 4)", async () => {
    const { store, svc } = make();
    store.leads.get("L1")!.version = 10;
    const e = await code(go(svc, "Contacted", 0));
    expect([e.status, e.code]).toEqual([409, "VERSION_CONFLICT"]);
    expect(e.message).toContain("Concurrency Conflict");
  });

  it("only the owner may transition (403), unknown lead is 404", async () => {
    const { svc } = make();
    const forbidden = await code(svc.transitionLead({ leadId: "L1", targetState: "Contacted", actorId: "intruder", expectedVersion: 0 }));
    expect(forbidden.status).toBe(403);
    const missing = await code(svc.transitionLead({ leadId: "NOPE", targetState: "Contacted", actorId: "userA", expectedVersion: 0 }));
    expect(missing.status).toBe(404);
  });

  it("Closed-Won needs a deal; with one it stores PENDING onboarding in the same update", async () => {
    const { store, svc } = make();
    store.leads.get("L1")!.currentState = "Negotiation";
    const e = await code(go(svc, "Closed-Won", 0));
    expect([e.status, e.code]).toEqual([400, "DEAL_REQUIRED"]);
    const won = await go(svc, "Closed-Won", 0, { deal });
    expect(won.onboardingStatus).toBe("PENDING");
    expect(won.deal).toEqual(deal);
  });

  it("a deal is not stored on other transitions", async () => {
    const { svc } = make();
    const l = await go(svc, "Contacted", 0, { deal });
    expect(l.deal).toBeUndefined();
    expect(l.onboardingStatus).toBeUndefined();
  });

  it("two concurrent requests with the same version: exactly one wins, one gets 409", async () => {
    const { store, svc } = make();
    const results = await Promise.all([go(svc, "Contacted", 0), go(svc, "Closed-Lost", 0)].map((p) => p.then(() => "ok", (e: AppError) => e.code)));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "VERSION_CONFLICT")).toHaveLength(1);
    expect(store.leads.get("L1")!.version).toBe(1);
    expect(store.leads.get("L1")!.activityHistory).toHaveLength(1);
  });

  it("moving to the current state is a no-op (no version bump, no audit row)", async () => {
    const { svc } = make();
    const l = await go(svc, "New", 0);
    expect(l.version).toBe(0);
    expect(l.activityHistory).toHaveLength(0);
  });

  it("every state can reach a closed state (no dead ends)", () => {
    const closed = new Set(["Closed-Won", "Closed-Lost"]);
    for (const start of Object.keys(ALLOWED_TRANSITIONS)) {
      const seen = new Set([start]); const stack = [start]; let hit = closed.has(start);
      while (stack.length) for (const n of ALLOWED_TRANSITIONS[stack.pop() as keyof typeof ALLOWED_TRANSITIONS]) { if (closed.has(n)) hit = true; if (!seen.has(n)) { seen.add(n); stack.push(n); } }
      expect(hit, start).toBe(true);
    }
  });
});
