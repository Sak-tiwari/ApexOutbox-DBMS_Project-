import { Router, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { NotFoundError, ValidationError } from '../errors';

/** What the UI needs to know about an invoice. Never includes the server file path. */
export interface InvoiceView {
  id: string;
  invoiceNumber: string;
  /** Template version used for this invoice (null for invoices made before templates). */
  templateVersionId?: string | null;
  gst?: { mode: string; rate: number; tax: number } | null;
  leadId: string | null;
  status: string;
  clientName: string;
  email: string;
  company: string;
  amount: number;
  currency: string;
  description: string;
  emailAttempts: number;
  lastError: string;
  hasPdf: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceReader {
  list(opts: { leadId?: string; limit: number }): Promise<InvoiceView[]>;
  /** Server-side path of the stored PDF, or null when it does not exist yet. */
  pdfPath(id: string): Promise<{ path: string; invoiceNumber: string } | null>;
}

export interface InvoiceRouterDeps {
  invoices: InvoiceReader;
  /** PDFs are only ever served from inside this directory. */
  invoiceDir: string;
}

const SAFE_NUMBER = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * GET /api/invoices?leadId=&limit=     newest first (limit 1-100, default 25)
 * GET /api/invoices/:id/pdf            streams the PDF (inline), only from inside INVOICE_DIR
 */
export function createInvoiceRouter(deps: InvoiceRouterDeps): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = req.query.limit === undefined ? 25 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('limit must be 1-100');
      const leadId = typeof req.query.leadId === 'string' && req.query.leadId ? req.query.leadId : undefined;
      if (leadId && leadId.length > 64) throw new ValidationError('Invalid leadId');
      const data = await deps.invoices.list({ leadId, limit });
      res.json({ success: true, count: data.length, data });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/pdf', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const found = await deps.invoices.pdfPath(String(req.params.id));
      if (!found) throw new NotFoundError('PDF not available yet');
      const root = path.resolve(deps.invoiceDir) + path.sep;
      const file = path.resolve(found.path);
      // Defence in depth: even if a bad path were stored, never serve anything outside the invoice folder.
      if (!file.startsWith(root) || !SAFE_NUMBER.test(found.invoiceNumber)) throw new NotFoundError('PDF not available');
      if (!fs.existsSync(file)) throw new NotFoundError('PDF file is missing on the server');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${found.invoiceNumber}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      fs.createReadStream(file).on('error', next).pipe(res);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
