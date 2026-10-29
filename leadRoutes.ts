import { Router, Request, Response } from 'express';
import { Lead } from '../models/Lead';
import { TransitionService } from '../services/TransitionService';

const router = Router();

// Simple mock authentication middleware to identify who is making the request
const fakeAuth = (req: Request, res: Response, next: any) => {
  req.headers['x-user-id'] = req.headers['x-user-id'] || 'sales_user_1'; 
  next();
};

/**
 * CONTRACT: GET /api/leads
 * Query Filters: ownerId, followUpBefore, followUpAfter
 */
router.get('/', fakeAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const { ownerId, followUpBefore, followUpAfter } = req.query;
    const filterQuery: any = {};

    if (ownerId) filterQuery.ownerId = ownerId as string;
    
    if (followUpBefore || followUpAfter) {
      filterQuery.followUpDate = {};
      if (followUpBefore) filterQuery.followUpDate.$lte = new Date(followUpBefore as string);
      if (followUpAfter) filterQuery.followUpDate.$gte = new Date(followUpAfter as string);
    }

    const leads = await Lead.find(filterQuery).select('-activityHistory');
    return res.status(200).json({ success: true, count: leads.length, data: leads });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * CONTRACT: GET /api/leads/:id
 * Fetches single lead details with full auditable history logs
 */
router.get('/:id', fakeAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
    return res.status(200).json({ success: true, data: lead });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * CONTRACT: POST /api/leads/:id/transition
 * Body params: targetState, version, reason
 */
router.post('/:id/transition', fakeAuth, async (req: Request, res: Response): Promise<any> => {
  try {
    const leadId = req.params.id;
    const actorId = req.headers['x-user-id'] as string;
    const { targetState, version, reason } = req.body;

    if (!targetState || version === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required targetState or version details' });
    }

    const updatedLead = await TransitionService.transitionLead(
      leadId,
      targetState,
      actorId,
      Number(version),
      reason
    );

    return res.status(200).json({ success: true, message: 'State transitioned successfully', data: updatedLead });
  } catch (error: any) {
    const isConflict = error.message.includes('Concurrency Conflict');
    const isInvalid = error.message.includes('Invalid Pipeline Transition') || error.message.includes('Reopening Guard');
    
    const statusCode = isConflict ? 409 : (isInvalid ? 422 : 400);
    return res.status(statusCode).json({ success: false, error: error.message });
  }
});

export default router;