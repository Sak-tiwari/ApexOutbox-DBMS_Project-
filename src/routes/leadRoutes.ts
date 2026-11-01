import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError, NotFoundError } from '../errors';
import { TransitionService } from '../services/TransitionService';
import { attemptOnboarding, OnboardFn } from '../services/onboardingHandoff';
import type { LeadStore } from '../stores/types';
import type { Log } from '../phase4/ports';
import type { Metrics } from '../metrics';
import { Lead } from '../models/Lead';

const STATES = ['New', 'Contacted', 'Follow-up', 'Negotiation', 'Closed-Won', 'Closed-Lost'] as const;

const dealSchema = z.object({
  email: z.string().email(),
  amount: z.number().finite().nonnegative().max(100_000_000)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'amount must have at most 2 decimal places'),
  currency: z.string().length(3).default('INR'),
  description: z.string().trim().min(1).max(500),
});

const transitionBody = z.object({
  targetState: z.enum(STATES),
  version: z.number().int().min(0),
  reason: z.string().trim().max(1000).optional(),
  deal: dealSchema.optional(),
});

const listQuery = z.object({
  ownerId: z.string().max(100).optional(),
  followUpBefore: z.coerce.date().optional(),
  followUpAfter: z.coerce.date().optional(),
});

export interface LeadRouterDeps {
  leads: LeadStore;
  transitions: TransitionService;
  onboard: OnboardFn;
  log: Log;
  metrics: Metrics;
}

/**
 * CONTRACTS (unchanged paths and body names from Phase 3):
 *   GET  /api/leads            filters: ownerId, followUpBefore, followUpAfter
 *   GET  /api/leads/:id
 *   POST /api/leads/:id/transition   { targetState, version, reason?, deal? }
 * New in Phase 5: authentication is required; `deal` is required for Closed-Won.
 */
export function createLeadRouter(deps: LeadRouterDeps): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) throw new ValidationError('Invalid query parameters', parsed.error.issues);
      const { ownerId, followUpBefore, followUpAfter } = parsed.data;
      const filterQuery: Record<string, unknown> = {};
      if (ownerId) filterQuery.ownerId = ownerId;
      if (followUpBefore || followUpAfter) {
        const range: Record<string, Date> = {};
        if (followUpBefore) range.$lte = followUpBefore;
        if (followUpAfter) range.$gte = followUpAfter;
        filterQuery.followUpDate = range;
      }
      const leads = await Lead.find(filterQuery).select('-activityHistory').limit(200).lean();
      return res.status(200).json({ success: true, count: leads.length, data: leads });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lead = await deps.leads.findById(String(req.params.id));
      if (!lead) throw new NotFoundError('Lead not found');
      return res.status(200).json({ success: true, data: lead });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/transition', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = transitionBody.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Missing or invalid targetState / version / deal details', parsed.error.issues);
      }
      const { targetState, version, reason, deal } = parsed.data;

      let lead;
      try {
        lead = await deps.transitions.transitionLead({
          leadId: String(req.params.id),
          targetState,
          actorId: req.userId!,
          expectedVersion: version,
          reason,
          deal,
        });
      } catch (error) {
        deps.metrics.inc('apexoutbox_transitions_total', { outcome: (error as { code?: string }).code ?? 'ERROR' });
        throw error;
      }
      deps.metrics.inc('apexoutbox_transitions_total', { outcome: 'OK' });

      let onboarding: string | undefined;
      if (lead.currentState === 'Closed-Won' && lead.onboardingStatus === 'PENDING') {
        onboarding = await attemptOnboarding(lead, { leads: deps.leads, onboard: deps.onboard, log: deps.log });
      } else {
        onboarding = lead.onboardingStatus;
      }

      return res.status(200).json({
        success: true,
        message: 'State transitioned successfully',
        data: lead,
        ...(onboarding ? { onboarding } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
