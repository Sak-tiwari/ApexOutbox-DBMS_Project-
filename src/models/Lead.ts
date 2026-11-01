import { Schema, model, Document } from 'mongoose';

export type LeadState = 'New' | 'Contacted' | 'Follow-up' | 'Negotiation' | 'Closed-Won' | 'Closed-Lost';

export interface IActivityLog {
    fromState: LeadState;
    toState: LeadState;
    changedBy: string;
    reason?: string;
    timestamp: Date;
}

export interface IDeal {
    email: string;
    amount: number;
    currency: string;
    description: string;
}

export type OnboardingStatus = 'PENDING' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface ILead extends Document {
    name: string;
    company: string;
    currentState: LeadState;
    ownerId: string;
    followUpDate?: Date;
    activityHistory: IActivityLog[];
    // Phase 5: Closed-Won hand-off to Phase 4. Written in the SAME single-document update as the
    // state change, so "won but nobody knows what to bill" cannot happen.
    deal?: IDeal;
    onboardingStatus?: OnboardingStatus;
    onboardingAttempts?: number;
    onboardingError?: string;
}

const ActivityLogSchema = new Schema<IActivityLog>({
    fromState: { type: String, required: true },
    toState: { type: String, required: true },
    changedBy: { type: String, required: true },
    reason: { type: String },
    timestamp: { type: Date, default: Date.now }
});

const LeadSchema = new Schema<ILead>({
    name: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    currentState: {
        type: String,
        enum: ['New', 'Contacted', 'Follow-up', 'Negotiation', 'Closed-Won', 'Closed-Lost'],
        default: 'New',
        required: true
    },
    ownerId: { type: String, required: true },
    followUpDate: { type: Date },
    activityHistory: [ActivityLogSchema],
    deal: {
        type: new Schema<IDeal>({
            email: { type: String, required: true, lowercase: true, trim: true },
            amount: { type: Number, required: true, min: 0 },
            currency: { type: String, required: true, default: 'INR' },
            description: { type: String, required: true, trim: true }
        }, { _id: false }),
        default: undefined
    },
    onboardingStatus: { type: String, enum: ['PENDING', 'DONE', 'FAILED', 'CANCELLED'], default: undefined },
    onboardingAttempts: { type: Number, default: 0 },
    onboardingError: { type: String, default: '' }
}, {
    timestamps: true,
    optimisticConcurrency: true // Enforces version checks (__v) automatically
});

export const Lead = model<ILead>('Lead', LeadSchema);

// Reconciler query: Closed-Won leads whose hand-off to Phase 4 has not completed.
LeadSchema.index({ onboardingStatus: 1, updatedAt: 1 });
LeadSchema.index({ ownerId: 1, currentState: 1 });
