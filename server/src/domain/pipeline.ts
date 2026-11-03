/**
 * Sales pipeline state machine (pure logic, no database access).
 * The single source of truth for which stage changes are legal.
 * Phase 3 wraps this in a transactional service; Phase 1 fixes the rules.
 */

export const LEAD_STATUSES = [
  "NEW",
  "CONTACTED",
  "FOLLOW_UP",
  "NEGOTIATION",
  "CLOSED_WON",
  "CLOSED_LOST",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const TERMINAL_STATUSES: readonly LeadStatus[] = ["CLOSED_WON", "CLOSED_LOST"];

/** Allowed normal transitions. Anything not listed is rejected. */
const TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  NEW: ["CONTACTED", "CLOSED_LOST"],
  CONTACTED: ["FOLLOW_UP", "NEGOTIATION", "CLOSED_LOST"],
  FOLLOW_UP: ["CONTACTED", "NEGOTIATION", "CLOSED_LOST"],
  NEGOTIATION: ["FOLLOW_UP", "CLOSED_WON", "CLOSED_LOST"],
  // CLOSED_WON is final in this project: a client and invoice may already exist.
  // Corrections are handled by a future credit-note flow, not by reopening.
  CLOSED_WON: [],
  // CLOSED_LOST can be reopened, but only through the audited reopen path below.
  CLOSED_LOST: [],
};

/** Controlled reopening: only from CLOSED_LOST, only to FOLLOW_UP, reason mandatory. */
const REOPEN: Partial<Record<LeadStatus, readonly LeadStatus[]>> = {
  CLOSED_LOST: ["FOLLOW_UP"],
};

export interface TransitionRequest {
  from: LeadStatus;
  to: LeadStatus;
  reason?: string;
}

export type TransitionVerdict =
  | { ok: true; kind: "normal" | "reopen"; sideEffects: readonly SideEffect[] }
  | { ok: false; code: "SAME_STATE" | "NOT_ALLOWED" | "REASON_REQUIRED"; message: string };

export type SideEffect = "CREATE_CLIENT_AND_OUTBOX_EVENT";

export function allowedNext(from: LeadStatus): readonly LeadStatus[] {
  return [...TRANSITIONS[from], ...(REOPEN[from] ?? [])];
}

export function evaluateTransition(req: TransitionRequest): TransitionVerdict {
  const { from, to, reason } = req;

  if (from === to) {
    return { ok: false, code: "SAME_STATE", message: `Lead is already ${from}.` };
  }

  if (TRANSITIONS[from].includes(to)) {
    const sideEffects: SideEffect[] = to === "CLOSED_WON" ? ["CREATE_CLIENT_AND_OUTBOX_EVENT"] : [];
    return { ok: true, kind: "normal", sideEffects };
  }

  if (REOPEN[from]?.includes(to)) {
    if (!reason || reason.trim().length < 5) {
      return {
        ok: false,
        code: "REASON_REQUIRED",
        message: "Reopening a closed lead requires a reason of at least 5 characters.",
      };
    }
    return { ok: true, kind: "reopen", sideEffects: [] };
  }

  return { ok: false, code: "NOT_ALLOWED", message: `Transition ${from} -> ${to} is not allowed.` };
}
