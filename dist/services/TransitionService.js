"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransitionService = exports.ALLOWED_TRANSITIONS = void 0;
const errors_1 = require("../errors");
const mongoLeadStore_1 = require("../stores/mongoLeadStore");
// Explicit allowed-transitions rule map (unchanged from Phase 3, now exported so tests can check it).
exports.ALLOWED_TRANSITIONS = {
    'New': ['Contacted', 'Closed-Lost'],
    'Contacted': ['Follow-up', 'Negotiation', 'Closed-Lost'],
    'Follow-up': ['Contacted', 'Negotiation', 'Closed-Lost'],
    'Negotiation': ['Closed-Won', 'Closed-Lost'],
    // Controlled Reopening Rules:
    'Closed-Won': ['Negotiation'],
    'Closed-Lost': ['New']
};
class TransitionService {
    leads;
    constructor(leads) {
        this.leads = leads;
    }
    /** Phase 3 call signature, kept so existing callers and tests keep working. */
    static async transitionLead(leadId, targetState, actorId, currentVersion, reason, deal) {
        return new TransitionService(new mongoLeadStore_1.MongoLeadStore()).transitionLead({
            leadId, targetState, actorId, expectedVersion: currentVersion, reason, deal,
        });
    }
    /**
     * Executes a pipeline state transition. Check order is the same as Phase 3:
     * not found -> owner -> version -> same state -> allowed transition -> reopen reason.
     * The final write is ONE conditional update, so two concurrent requests holding the same
     * version cannot both succeed (the loser gets VERSION_CONFLICT).
     */
    async transitionLead(input) {
        const { leadId, targetState, actorId, expectedVersion, reason, deal } = input;
        const lead = await this.leads.findById(leadId);
        if (!lead)
            throw new errors_1.NotFoundError('Lead not found');
        if (lead.ownerId !== actorId) {
            throw new errors_1.ForbiddenError('Unauthorized: Only the lead owner can transition pipeline states');
        }
        if (lead.version !== expectedVersion) {
            throw new errors_1.ConflictError('Concurrency Conflict: Lead state was updated by another session. Please refresh.');
        }
        const startState = lead.currentState;
        if (startState === targetState)
            return lead;
        const validNextStates = exports.ALLOWED_TRANSITIONS[startState] || [];
        if (!validNextStates.includes(targetState)) {
            throw new errors_1.InvalidTransitionError(`Invalid Pipeline Transition: Cannot move directly from ${startState} to ${targetState}`, validNextStates);
        }
        if ((startState === 'Closed-Won' || startState === 'Closed-Lost') && !reason?.trim()) {
            throw new errors_1.ReasonRequiredError('Reopening Guard: A clear reason must be provided to reopen a closed lead');
        }
        if (targetState === 'Closed-Won' && !deal) {
            throw new errors_1.ValidationError('A deal (email, amount, currency, description) is required to mark a lead Closed-Won', undefined, 'DEAL_REQUIRED');
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
            throw new errors_1.ConflictError('Concurrency Conflict: Lead state was updated by another session. Please refresh.');
        }
        if (startState === 'Closed-Won') {
            // Re-opened before onboarding finished: stop the reconciler from billing a deal that is no longer won.
            await this.leads.cancelPendingOnboarding(leadId);
            return (await this.leads.findById(leadId)) ?? updated;
        }
        return updated;
    }
}
exports.TransitionService = TransitionService;
//# sourceMappingURL=TransitionService.js.map