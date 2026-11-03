import type { IActivityLog, IDeal, LeadState, OnboardingStatus } from "../models/Lead";

/** Plain data shape of a lead, independent of Mongoose. */
export interface LeadRecord {
  id: string;
  name: string;
  company: string;
  currentState: LeadState;
  ownerId: string;
  version: number;
  followUpDate?: Date;
  activityHistory: IActivityLog[];
  deal?: IDeal;
  onboardingStatus?: OnboardingStatus;
  onboardingAttempts: number;
  onboardingError: string;
}

export interface ListLeadsQuery {
  ownerId?: string;
  state?: LeadState;
  followUpBefore?: Date;
  followUpAfter?: Date;
  limit: number;
  /** Opaque cursor from a previous page (the id of its last item). */
  after?: string;
}

export interface NewLead {
  name: string;
  company: string;
  ownerId: string;
  followUpDate?: Date;
}

export interface TransitionWrite {
  id: string;
  expectedVersion: number;
  from: LeadState;
  to: LeadState;
  entry: IActivityLog;
  deal?: IDeal;
}

/**
 * Persistence port for leads. The Mongo implementation uses ONE conditional update
 * ({_id, version, state} -> new state + history entry + version+1), so the version check and the
 * write cannot be separated by another request.
 */
export interface LeadStore {
  findById(id: string): Promise<LeadRecord | null>;
  /** Returns the updated lead, or null when the version or state no longer matches. */
  applyTransition(write: TransitionWrite): Promise<LeadRecord | null>;
  list(query: ListLeadsQuery): Promise<{ items: LeadRecord[]; nextCursor: string | null }>;
  create(lead: NewLead): Promise<LeadRecord>;
  /** A lead that left Closed-Won while its onboarding was still PENDING must not be onboarded any more. */
  cancelPendingOnboarding(id: string): Promise<void>;
  findOnboardingPending(limit: number): Promise<LeadRecord[]>;
  markOnboarding(id: string, status: OnboardingStatus, error?: string): Promise<void>;
}
