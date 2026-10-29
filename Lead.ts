import { Schema, model, Document } from 'mongoose';

export type LeadState = 'New' | 'Contacted' | 'Follow-up' | 'Negotiation' | 'Closed-Won' | 'Closed-Lost';

export interface IActivityLog {
    fromState: LeadState;
    toState: LeadState;
    changedBy: string;
    reason?: string;
    timestamp: Date;
}

export interface ILead extends Document {
    name: string;
    company: string;
    currentState: LeadState;
    ownerId: string;
    followUpDate?: Date;
    activityHistory: IActivityLog[];
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
    activityHistory: [ActivityLogSchema]
}, {
    timestamps: true,
    optimisticConcurrency: true // Enforces version checks (__v) automatically
});

export const Lead = model<ILead>('Lead', LeadSchema);