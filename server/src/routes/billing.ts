import { Router } from "express";
import { z } from "zod";
import { ClientsService } from "../clients/service.js";
import { isUuid } from "../db/pool.js";
import { EMAIL_STATUSES, EmailService } from "../email/service.js";
import { NotFoundError } from "../errors.js";
import { limitSchema } from "../http/pagination.js";
import { parse } from "../http/validate.js";
import type { InvoiceStatus, InvoicesService } from "../invoices/service.js";
import { clean, email, nullable, optionalText, phone } from "../leads/validation.js";
import { authOf, type AuthMiddleware } from "../middleware/auth.js";

const idOf = (raw: unknown, what: string) => {
  if (typeof raw !== "string" || !isUuid(raw)) throw new NotFoundError(`${what} not found`);
  return raw;
};
const csv = <T extends [string, ...string[]]>(values: T) =>
  z.string().optional().transform((v) => (v ? v.split(",") : undefined)).pipe(z.array(z.enum(values)).max(values.length).optional());
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const address = z.object({ line1: z.string().trim().max(200), line2: z.string().trim().max(200), city: z.string().trim().max(100), state: z.string().trim().max(100), postalCode: z.string().trim().max(20), country: z.string().trim().max(100) }).partial().strict();

const clientList = z.object({ limit: limitSchema, cursor: z.string().max(500).optional(), q: z.string().trim().max(100).optional() });
const clientPatch = z
  .object({ name: clean(200), companyName: optionalText(200), email, phone: nullable(phone), billingAddress: address, taxId: z.string().trim().max(40).nullable() })
  .partial().strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export function createClientsRouter(deps: { service: ClientsService; auth: AuthMiddleware }) {
  const { service, auth } = deps;
  const r = Router();
  r.use(auth.requireAuth());
  r.get("/", auth.requirePermission("clients:read"), async (req, res) => res.json(await service.list(authOf(req), parse(clientList, req.query, "Query"))));
  r.get("/:id", auth.requirePermission("clients:read"), async (req, res) => res.json(await service.get(authOf(req), idOf(req.params.id, "Client"))));
  r.patch("/:id", auth.requirePermission("clients:write"), async (req, res) => {
    const body = parse(clientPatch, req.body);
    const billingAddress = body.billingAddress ? (Object.fromEntries(Object.entries(body.billingAddress).filter(([, v]) => !!v)) as Record<string, string>) : undefined;
    res.json(await service.update(authOf(req), idOf(req.params.id, "Client"), { ...body, billingAddress }, req.ip));
  });
  return r;
}

const INVOICE_STATUS = ["DRAFT", "ISSUED", "SENT", "PAID", "VOID"] as [string, ...string[]];
const invoiceList = z.object({
  limit: limitSchema, cursor: z.string().max(500).optional(), q: z.string().trim().max(100).optional(),
  status: csv(INVOICE_STATUS), clientId: z.string().uuid().optional(), overdue: bool.optional(),
});
const voidBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const resendBody = z.object({ to: email.optional() }).strict();

export function createInvoicesRouter(deps: { service: InvoicesService; auth: AuthMiddleware; onEmailQueued?: () => void }) {
  const { service, auth } = deps;
  const r = Router();
  r.use(auth.requireAuth());
  r.get("/", auth.requirePermission("invoices:read"), async (req, res) => {
    const q = parse(invoiceList, req.query, "Query");
    res.json(await service.list(authOf(req), { ...q, status: q.status as InvoiceStatus[] | undefined }));
  });
  r.get("/stats", auth.requirePermission("invoices:read"), async (req, res) => res.json(await service.stats(authOf(req))));
  r.get("/:id", auth.requirePermission("invoices:read"), async (req, res) => res.json(await service.get(authOf(req), idOf(req.params.id, "Invoice"))));
  r.get("/:id/pdf", auth.requirePermission("invoices:read"), async (req, res) => {
    const { bytes, filename } = await service.pdf(authOf(req), idOf(req.params.id, "Invoice"));
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Content-Length": String(bytes.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.end(bytes);
  });
  r.post("/:id/mark-paid", auth.requirePermission("invoices:manage"), async (req, res) => res.json(await service.markPaid(authOf(req), idOf(req.params.id, "Invoice"), req.ip)));
  r.post("/:id/void", auth.requirePermission("invoices:manage"), async (req, res) =>
    res.json(await service.void(authOf(req), idOf(req.params.id, "Invoice"), parse(voidBody, req.body).reason, req.ip)));
  r.post("/:id/resend", auth.requirePermission("invoices:manage"), async (req, res) => {
    const out = await service.resend(authOf(req), idOf(req.params.id, "Invoice"), parse(resendBody, req.body ?? {}).to, req.ip);
    deps.onEmailQueued?.();
    res.status(202).json(out);
  });
  return r;
}

const emailList = z.object({ limit: limitSchema, cursor: z.string().max(500).optional(), status: csv(EMAIL_STATUSES as unknown as [string, ...string[]]) });
const resolveBody = z.object({ outcome: z.enum(["delivered", "not_delivered"]) }).strict();

export function createEmailsRouter(deps: { service: EmailService; auth: AuthMiddleware; onEmailQueued?: () => void }) {
  const { service, auth } = deps;
  const r = Router();
  r.use(auth.requireAuth());
  r.get("/", auth.requirePermission("invoices:read"), async (req, res) => {
    const q = parse(emailList, req.query, "Query");
    res.json(await service.list(authOf(req), { ...q, status: q.status as never }));
  });
  r.get("/stats", auth.requirePermission("invoices:read"), async (req, res) => res.json(await service.stats(authOf(req))));
  r.post("/:id/retry", auth.requirePermission("invoices:manage"), async (req, res) => {
    await service.retry(authOf(req), idOf(req.params.id, "E-mail"), req.ip);
    deps.onEmailQueued?.();
    res.status(202).end();
  });
  r.post("/:id/resolve", auth.requirePermission("invoices:manage"), async (req, res) => {
    await service.resolve(authOf(req), idOf(req.params.id, "E-mail"), parse(resolveBody, req.body).outcome, req.ip);
    deps.onEmailQueued?.();
    res.status(204).end();
  });
  return r;
}
