
export interface OnboardingRequest {
  leadId: string;
  clientName: string;
  email: string;
  company?: string;
  amount: number;
  currency?: string;
  description: string;
  ownerId?: string;
  invoiceNumber?: string;
  businessGstin?: string;
  clientGstin?: string;
  clientAddress?: string;
  clientState?: string;
  gstRate?: number;
  templateId?: string;
}

export interface InvoiceSnapshot {
  clientName: string;
  email: string;
  company: string;
  /** What the client pays. For invoices with GST this is the total including tax. */
  amount: number;
  currency: string;
  description: string;
  createdAt: Date;
  // ---- Invoice Templates (optional: invoices made before this feature have none of these) ----
  ownerId?: string;
  /** The number printed on the invoice: typed by the user, or the internal number. */
  displayNumber?: string;
  dueDate?: Date;
  business?: SnapshotBusiness;
  clientAddress?: string;
  clientState?: string;
  clientGstin?: string;
  items?: Array<{ description: string; qty: number; rate: number; taxRate: number; amount: number }>;
  gstRate?: number;
  totals?: { subtotal: number; discount: number; cgst: number; sgst: number; igst: number; total: number; mode: "intra" | "inter" | "none" };
  /** Which template version this invoice was made with ("builtin:standard@1" or a version id). Never changes afterwards. */
  templateVersionId?: string;
}

export interface SnapshotBusiness {
  name: string; address: string; gstin: string; state: string; email: string; phone: string; logoAssetId: string;
  bankName: string; account: string; ifsc: string; upiId: string; paymentLink: string; qrAssetId: string; terms: string;
}

export interface OnboardingJob {
  invoiceId: string;
}
