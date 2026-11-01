"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Lead = void 0;
const mongoose_1 = require("mongoose");
const ActivityLogSchema = new mongoose_1.Schema({
    fromState: { type: String, required: true },
    toState: { type: String, required: true },
    changedBy: { type: String, required: true },
    reason: { type: String },
    timestamp: { type: Date, default: Date.now }
});
const LeadSchema = new mongoose_1.Schema({
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
        type: new mongoose_1.Schema({
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
exports.Lead = (0, mongoose_1.model)('Lead', LeadSchema);
// Reconciler query: Closed-Won leads whose hand-off to Phase 4 has not completed.
LeadSchema.index({ onboardingStatus: 1, updatedAt: 1 });
LeadSchema.index({ ownerId: 1, currentState: 1 });
//# sourceMappingURL=Lead.js.map