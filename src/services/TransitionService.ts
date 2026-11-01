import { LeadState, IDeal } from '../models/Lead';
import { ConflictError, ForbiddenError, InvalidTransitionError, NotFoundError, ReasonRequiredError, ValidationError } from '../errors';
import type { LeadRecord, LeadStore } from '../stores/types';
import { MongoLeadStore } from '../stores/mongoLeadStore';

// Explicit allowed-transitions rule map (unchanged from Phase 3, now exported so tests can check it).
export const ALLOWED_TRANSITIONS: Record<LeadState, LeadState[]> = {
    'New': ['Contacted', 'Closed-Lost'],
    'Contacted': ['Follow-up', 'Negotiation', 'Closed-Lost'],
    'Follow-up': ['Contacted', 'Negotiation', 'Closed-Lost'],
    'Negotiation': ['Closed-Won', 'Closed-Lost'],
    // Controlled Reopening Rules:
    'Closed-Won': ['Negotiation'],
    'Closed-Lost': ['New']
};

export interface TransitionInput {
    leadId: string;
    targetState: LeadState;
    actorId: string;
    expectedVersion: number;
    reason?: string;
    /** Required when targetState is Closed-Won: what to bill and where to send the invoice. */
    deal?: IDeal;
}

export class TransitionService {
    constructor(private readonly leads: LeadStore) {}

    /** Phase 3 call signature, kept so existing callers and tests keep working. */
    static async transitionLead(
        leadId: string,
        targetState: LeadState,
        actorId: string,
        currentVersion: number,
        reason?: string,
        deal?: IDeal,
    ): Promise<LeadRecord> {
        return new TransitionService(new MongoLeadStore()).transitionLead({
            leadId, targetState, actorId, expectedVersion: currentVersion, reason, deal,
        });
    }

    /**
     * Executes a pipeline state transition. Check order is the same as Phase 3:
     * not found -> owner -> version -> same state -> allowed transition -> reopen reason.
     * The final write is ONE conditional update, so two concurrent requests holding the same
     * version cannot both succeed (the loser gets VERSION_CONFLICT).
     */
    async transitionLead(input: TransitionInput): Promise<LeadRecord> {
        const { leadId, targetState, actorId, expectedVersion, reason, deal } = input;

        const lead = await this.leads.findById(leadId);
        if (!lead) throw new NotFoundError('Lead not found');

        if (lead.ownerId !== actorId) {
            throw new ForbiddenError('Unauthorized: Only the lead owner can transition pipeline states');
        }

        if (lead.version !== expectedVersion) {
            throw new ConflictError('Concurrency Conflict: Lead state was updated by another session. Please refresh.');
        }

        const startState = lead.currentState;
        if (startState === targetState) return lead;

        const validNextStates = ALLOWED_TRANSITIONS[startState] || [];
        if (!validNextStates.includes(targetState)) {
            throw new InvalidTransitionError(
                `Invalid Pipeline Transition: Cannot move directly from ${startState} to ${targetState}`,
                validNextStates,
            );
        }

        if ((startState === 'Closed-Won' || startState === 'Closed-Lost') && !reason?.trim()) {
            throw new ReasonRequiredError('Reopening Guard: A clear reason must be provided to reopen a closed lead');
        }

        if (targetState === 'Closed-Won' && !deal) {
            throw new ValidationError('A deal (email, amount, currency, description) is required to mark a lead Closed-Won', undefined, 'DEAL_REQUIRED');
        }

        const updated = await this.leads.applyTransition({
            id: leadId,
            expectedVersion,
            from: startState,
            to: targetState,
            entry: {
                fromState: startState,
                toState: targetState,
                changedBy: actorId,
                reason: reason?.trim() || 'Standard Pipeline Progression',
                timestamp: new Date(),
            },
            deal: targetState === 'Closed-Won' ? deal : undefined,
        });

        if (!updated) {
            throw new ConflictError('Concurrency Conflict: Lead state was updated by another session. Please refresh.');
        }
        return updated;
    }
}
