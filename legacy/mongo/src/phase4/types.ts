
export interface OnboardingRequest {
  leadId: string;
  clientName: string;
  email: string;
  company?: string;
  amount: number;
  currency?: string;
  description: string;
}

export interface InvoiceSnapshot {
  clientName: string;
  email: string;
  company: string;
  amount: number;
  currency: string;
  description: string;
  createdAt: Date;
}

export interface OnboardingJob {
  invoiceId: string;
}
