export type Role = "OWNER" | "ADMIN" | "MEMBER";
export type Permission =
  | "leads:read" | "leads:write" | "leads:delete" | "scrape:run" | "scrape:manage_domains" | "clients:read" | "clients:write"
  | "invoices:read" | "invoices:manage" | "users:read" | "users:manage" | "tenant:settings" | "audit:read" | "data:export" | "tenant:delete";

export interface User { id: string; name: string; email: string; role: Role; totpEnabled: boolean; mustChangePassword: boolean }
export interface Me { user: User; tenant: { id: string; name: string; slug: string; settings: Record<string, unknown> }; permissions: Permission[] }

export const LEAD_STATUSES = ["NEW", "CONTACTED", "FOLLOW_UP", "NEGOTIATION", "CLOSED_WON", "CLOSED_LOST"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: "New", CONTACTED: "Contacted", FOLLOW_UP: "Follow-up", NEGOTIATION: "Negotiation", CLOSED_WON: "Won", CLOSED_LOST: "Lost",
};

export interface Lead {
  id: string; name: string; companyName: string | null; email: string | null; phone: string | null; website: string | null;
  needsReview: boolean; status: LeadStatus; version: number; ownerId: string | null; followUpAt: string | null;
  sourceAdapter: string; sourceUrl: string | null; clientId: string | null; createdAt: string; updatedAt: string; allowedNext: LeadStatus[];
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface LeadStats { total: number; byStatus: Record<LeadStatus, number>; needsReview: number; followUpDue: number }

export type InvoiceStatus = "DRAFT" | "ISSUED" | "SENT" | "PAID" | "VOID";
export interface Invoice {
  id: string; number: string | null; status: InvoiceStatus; clientId: string; clientName: string; currency: string;
  totalMinor: number; issuedAt: string | null; dueAt: string | null; paidAt: string | null; overdue: boolean;
}
export interface InvoiceStats {
  byStatus: Record<string, { count: number; totalMinor: number }>; outstandingMinor: number; paidMinor: number;
  overdue: { count: number; totalMinor: number }; monthly: { month: string; billedMinor: number; paidMinor: number }[];
}
export type EmailStatus = "PENDING" | "SENDING" | "SENT" | "FAILED" | "UNCERTAIN" | "ABANDONED";
export interface EmailItem {
  id: string; invoiceNumber: string | null; to: string; subject: string; status: EmailStatus; attempts: number; maxAttempts: number;
  lastError: string | null; sentAt: string | null; createdAt: string;
}
export interface EmailStats { byStatus: Record<EmailStatus, number>; needsAttention: number }
export interface ScrapeJob {
  id: string; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"; urls: string[]; pagesTotal: number; pagesDone: number;
  found: number; inserted: number; duplicates: number; rejected: number; errors: { url: string; message: string }[]; createdAt: string;
}
export interface Domain { id: string; domain: string }
export interface Client { id: string; name: string; email: string | null; createdAt: string }
