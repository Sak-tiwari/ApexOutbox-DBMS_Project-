"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLeadRouter = createLeadRouter;
const express_1 = require("express");
const zod_1 = require("zod");
const errors_1 = require("../errors");
const onboardingHandoff_1 = require("../services/onboardingHandoff");
const STATES = ['New', 'Contacted', 'Follow-up', 'Negotiation', 'Closed-Won', 'Closed-Lost'];
const dealSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    amount: zod_1.z.number().finite().nonnegative().max(100_000_000)
        .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'amount must have at most 2 decimal places'),
    currency: zod_1.z.string().length(3).default('INR'),
    description: zod_1.z.string().trim().min(1).max(500),
});
const transitionBody = zod_1.z.object({
    targetState: zod_1.z.enum(STATES),
    // Accepts 3 and "3" (form clients, curl) but rejects "", "3.5", "-1" and "abc".
    version: zod_1.z.union([zod_1.z.number().int().min(0), zod_1.z.string().regex(/^\d{1,9}$/).transform(Number)]),
    reason: zod_1.z.string().trim().max(1000).optional(),
    deal: dealSchema.optional(),
});
const createBody = zod_1.z.object({
    name: zod_1.z.string().trim().min(1).max(200),
    company: zod_1.z.string().trim().min(1).max(200),
    followUpDate: zod_1.z.coerce.date().optional(),
});
const listQuery = zod_1.z.object({
    state: zod_1.z.enum(STATES).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(25),
    cursor: zod_1.z.string().max(100).optional(),
    ownerId: zod_1.z.string().max(100).optional(),
    followUpBefore: zod_1.z.coerce.date().optional(),
    followUpAfter: zod_1.z.coerce.date().optional(),
});
/**
 * CONTRACTS (unchanged paths and body names from Phase 3):
 *   GET  /api/leads            filters: state, ownerId, followUpBefore, followUpAfter; paging: limit (1-100, default 25), cursor
 *   POST /api/leads            { name, company, followUpDate? }  (owner = the calling API key's user)
 *   GET  /api/leads/:id
 *   POST /api/leads/:id/transition   { targetState, version, reason?, deal? }
 * New in Phase 5: authentication is required; `deal` is required for Closed-Won.
 */
function createLeadRouter(deps) {
    const router = (0, express_1.Router)();
    router.get('/', async (req, res, next) => {
        try {
            const parsed = listQuery.safeParse(req.query);
            if (!parsed.success)
                throw new errors_1.ValidationError('Invalid query parameters', parsed.error.issues);
            const { ownerId, followUpBefore, followUpAfter, state, limit, cursor } = parsed.data;
            let after;
            if (cursor) {
                after = Buffer.from(cursor, 'base64url').toString('utf8');
                if (!after || Buffer.from(after, 'utf8').toString('base64url') !== cursor)
                    throw new errors_1.ValidationError('Invalid cursor');
            }
            const page = await deps.leads.list({ ownerId, state, followUpBefore, followUpAfter, limit, after });
            const data = page.items.map(({ activityHistory: _omit, ...rest }) => rest);
            return res.status(200).json({
                success: true,
                count: data.length,
                data,
                nextCursor: page.nextCursor ? Buffer.from(page.nextCursor, 'utf8').toString('base64url') : null,
            });
        }
        catch (error) {
            next(error);
        }
    });
    router.post('/', async (req, res, next) => {
        try {
            const parsed = createBody.safeParse(req.body);
            if (!parsed.success)
                throw new errors_1.ValidationError('Invalid lead', parsed.error.issues);
            // The creator owns the lead: ownership comes from the API key, never from the request body.
            const lead = await deps.leads.create({ ...parsed.data, ownerId: req.userId });
            return res.status(201).json({ success: true, data: lead });
        }
        catch (error) {
            next(error);
        }
    });
    router.get('/:id', async (req, res, next) => {
        try {
            const lead = await deps.leads.findById(String(req.params.id));
            if (!lead)
                throw new errors_1.NotFoundError('Lead not found');
            return res.status(200).json({ success: true, data: lead });
        }
        catch (error) {
            next(error);
        }
    });
    router.post('/:id/transition', async (req, res, next) => {
        try {
            const parsed = transitionBody.safeParse(req.body);
            if (!parsed.success) {
                throw new errors_1.ValidationError('Missing or invalid targetState / version / deal details', parsed.error.issues);
            }
            const { targetState, version, reason, deal } = parsed.data;
            let lead;
            try {
                lead = await deps.transitions.transitionLead({
                    leadId: String(req.params.id),
                    targetState,
                    actorId: req.userId,
                    expectedVersion: version,
                    reason,
                    deal,
                });
            }
            catch (error) {
                deps.metrics.inc('apexoutbox_transitions_total', { outcome: error.code ?? 'ERROR' });
                throw error;
            }
            deps.metrics.inc('apexoutbox_transitions_total', { outcome: 'OK' });
            let onboarding;
            if (lead.currentState === 'Closed-Won' && lead.onboardingStatus === 'PENDING') {
                onboarding = await (0, onboardingHandoff_1.attemptOnboarding)(lead, { leads: deps.leads, onboard: deps.onboard, log: deps.log });
            }
            else {
                onboarding = lead.onboardingStatus;
            }
            return res.status(200).json({
                success: true,
                message: 'State transitioned successfully',
                data: lead,
                ...(onboarding ? { onboarding } : {}),
            });
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=leadRoutes.js.map