import { describe, it, expect } from "vitest";
import { LEAD_STATUSES, allowedNext, evaluateTransition, type LeadStatus } from "../src/domain/pipeline.js";

describe("pipeline state machine", () => {
  it("allows the happy path New -> Contacted -> Negotiation -> Closed-Won", () => {
    expect(evaluateTransition({ from: "NEW", to: "CONTACTED" }).ok).toBe(true);
    expect(evaluateTransition({ from: "CONTACTED", to: "NEGOTIATION" }).ok).toBe(true);
    const won = evaluateTransition({ from: "NEGOTIATION", to: "CLOSED_WON" });
    expect(won.ok).toBe(true);
    if (won.ok) expect(won.sideEffects).toContain("CREATE_CLIENT_AND_OUTBOX_EVENT");
  });

  it("rejects skipping stages", () => {
    const v = evaluateTransition({ from: "NEW", to: "CLOSED_WON" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("NOT_ALLOWED");
  });

  it("rejects a transition to the same state", () => {
    const v = evaluateTransition({ from: "CONTACTED", to: "CONTACTED" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("SAME_STATE");
  });

  it("makes Closed-Won final", () => {
    expect(allowedNext("CLOSED_WON")).toEqual([]);
    for (const to of LEAD_STATUSES) {
      expect(evaluateTransition({ from: "CLOSED_WON", to, reason: "trying anyway" }).ok).toBe(false);
    }
  });

  it("requires a reason to reopen Closed-Lost, and only to Follow-up", () => {
    const noReason = evaluateTransition({ from: "CLOSED_LOST", to: "FOLLOW_UP" });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.code).toBe("REASON_REQUIRED");

    const ok = evaluateTransition({ from: "CLOSED_LOST", to: "FOLLOW_UP", reason: "Client came back" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.kind).toBe("reopen");

    expect(evaluateTransition({ from: "CLOSED_LOST", to: "NEGOTIATION", reason: "Client came back" }).ok).toBe(false);
  });

  it("only Closed-Won triggers conversion side effects", () => {
    for (const from of LEAD_STATUSES) {
      for (const to of LEAD_STATUSES) {
        const v = evaluateTransition({ from, to, reason: "valid reason" });
        if (v.ok && v.sideEffects.length > 0) {
          expect(to).toBe<LeadStatus>("CLOSED_WON");
        }
      }
    }
  });

  it("every status can reach a terminal state (no dead-end loops)", () => {
    const terminals = new Set<LeadStatus>(["CLOSED_WON", "CLOSED_LOST"]);
    for (const start of LEAD_STATUSES) {
      const seen = new Set<LeadStatus>([start]);
      const stack: LeadStatus[] = [start];
      let reached = terminals.has(start);
      while (stack.length) {
        const cur = stack.pop()!;
        for (const nxt of allowedNext(cur)) {
          if (terminals.has(nxt)) reached = true;
          if (!seen.has(nxt)) {
            seen.add(nxt);
            stack.push(nxt);
          }
        }
      }
      expect(reached).toBe(true);
    }
  });
});
