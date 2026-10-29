import { Lead, LeadState, ILead } from '../models/Lead';

// Define explicit allowed transitions rule map
const ALLOWED_TRANSITIONS: Record<LeadState, LeadState[]> = {
    'New': ['Contacted', 'Closed-Lost'],
    'Contacted': ['Follow-up', 'Negotiation', 'Closed-Lost'],
    'Follow-up': ['Contacted', 'Negotiation', 'Closed-Lost'],
    'Negotiation': ['Closed-Won', 'Closed-Lost'],
    // Controlled Reopening Rules:
    'Closed-Won': ['Negotiation'],
    'Closed-Lost': ['New']
};

export class TransitionService {
    /**
     * Executes a pipeline state transition safely with concurrency guards
     */
    static async transitionLead(
        leadId: string,
        targetState: LeadState,
        actorId: string,
        currentVersion: number,
        reason?: string
    ): Promise<ILead> {
        const lead = await Lead.findById(leadId);
        if (!lead) throw new Error('Lead not found');

        // 1. Authorization Guard
        if (lead.ownerId !== actorId) {
            throw new Error('Unauthorized: Only the lead owner can transition pipeline states');
        }

        // 2. Optimistic Concurrency Check
        if (lead.__v !== currentVersion) {
            throw new Error('Concurrency Conflict: Lead state was updated by another session. Please refresh.');
        }

        const startState = lead.currentState;

        // 3. Prevent transitioning to the exact same state
        if (startState === targetState) {
            return lead;
        }

        // 4. Validate State Machine Constraints
        const validNextStates = ALLOWED_TRANSITIONS[startState] || [];
        if (!validNextStates.includes(targetState)) {
            throw new Error(`Invalid Pipeline Transition: Cannot move directly from ${startState} to ${targetState}`);
        }

        // 5. Enforce Controlled Reopening Reason Validation
        if ((startState === 'Closed-Won' || startState === 'Closed-Lost') && !reason) {
            throw new Error(`Reopening Guard: A clear reason must be provided to reopen a closed lead`);
        }

        // 6. Record Transition History Update
        lead.activityHistory.push({
            fromState: startState,
            toState: targetState,
            changedBy: actorId,
            reason: reason || 'Standard Pipeline Progression',
            timestamp: new Date()
        });

        lead.currentState = targetState;

        // Save triggers Mongoose optimistic concurrency protection internally via __v
        return await lead.save();
    }
}