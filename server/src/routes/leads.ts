import express, { Router } from "express";
import { z } from "zod";
import { LEAD_STATUSES } from "../domain/pipeline.js";
import { isUuid } from "../db/pool.js";
import { AppError, NotFoundError } from "../errors.js";
import { rateLimit } from "../http/rateLimit.js";
import { CsvFormatError, parseCsv, validateRows } from "../leads/csv.js";
import { limitSchema } from "../http/pagination.js";
import { parse } from "../http/validate.js";
import { MAX_QUANTITY, MAX_UNIT_MINOR } from "../invoices/money.js";
import { LeadsService } from "../leads/service.js";
import { clean, email, nullable, optionalText, phone, website } from "../leads/validation.js";
import { authOf, type AuthMiddleware } from "../middleware/auth.js";

const fields = {
  companyName: optionalText(200),
  email: nullable(email),
  phone: nullable(phone),
  website: nullable(website),
  ownerId: z.string().uuid().nullable(),
  followUpAt: z.string().datetime({ offset: true }).nullable(),
};
const createSchema = z
  .object({ name: clean(200), ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) } as {
    name: ReturnType<typeof clean>;
  } & { [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]> })
  .strict();
const patchSchema = z
  .object({ name: clean(200).optional(), ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])), version: z.number().int().min(0) } as {
    name: z.ZodOptional<ReturnType<typeof clean>>;
    version: z.ZodNumber;
  } & { [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]> })
  .strict();
const addressField = z.string().trim().max(200).optional();
const dealSchema = z
  .object({
    email,
    billingAddress: z.object({ line1: addressField, line2: addressField, city: addressField, state: addressField, postalCode: addressField, country: addressField }).strict()
      .transform((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => !!v)) as Record<string, string>).optional(),
    taxId: z.string().trim().max(40).nullable().optional(),
    items: z
      .array(
        z.object({
          description: clean(500),
          quantity: z.number().positive().max(MAX_QUANTITY).refine((q) => Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6, "At most 3 decimals"),
          unitAmountMinor: z.number().int().min(0).max(MAX_UNIT_MINOR),
          taxRateBp: z.number().int().min(0).max(10_000).optional(),
        }).strict(),
      )
      .min(1)
      .max(50)
      .optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    dueInDays: z.number().int().min(0).max(365).optional(),
    sendEmail: z.boolean().optional(),
  })
  .strict();
const transitionSchema = z.object({ to: z.enum(LEAD_STATUSES), version: z.number().int().min(0), reason: z.string().trim().max(1000).optional(), deal: dealSchema.optional() }).strict();
const noteSchema = z.object({ note: clean(1000) }).strict();

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const listSchema = z.object({
  limit: limitSchema,
  cursor: z.string().max(500).optional(),
  q: z.string().trim().max(100).optional(),
  status: z.string().optional().transform((v) => (v ? v.split(",") : undefined)).pipe(z.array(z.enum(LEAD_STATUSES)).max(6).optional()),
  ownerId: z.string().uuid().optional(),
  unowned: bool.optional(),
  needsReview: bool.optional(),
  followUpDue: bool.optional(),
});

const idOf = (raw: unknown) => {
  if (typeof raw !== "string" || !isUuid(raw)) throw new NotFoundError("Lead not found");
  return raw;
};

export function createLeadsRouter(deps: { service: LeadsService; auth: AuthMiddleware; now?: () => number; onEmailQueued?: () => void }) {
  const { service, auth } = deps;
  const router = Router();
  router.use(auth.requireAuth());

  // CSV upload: raw text body (text/csv), at most 512 KB and 1000 rows. 10 imports per user per hour.
  const importLimit = rateLimit({ name: "lead-import", limit: 10, windowMs: 60 * 60_000, key: (req) => authOf(req).userId, now: deps.now });
  router.post("/import", auth.requirePermission("leads:write"), importLimit, express.text({ type: ["text/csv", "text/plain"], limit: "512kb" }), async (req, res) => {
    if (typeof req.body !== "string" || req.body.length === 0) throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the file contents with Content-Type: text/csv");
    try {
      const { rows, errors } = validateRows(parseCsv(req.body));
      res.status(201).json(await service.importRows(authOf(req), rows, errors, req.ip));
    } catch (err) {
      if (err instanceof CsvFormatError) throw new AppError(400, err.code, err.message);
      throw err;
    }
  });

  router.get("/", auth.requirePermission("leads:read"), async (req, res) => {
    res.json(await service.list(authOf(req), parse(listSchema, req.query, "Query")));
  });
  router.get("/stats", auth.requirePermission("leads:read"), async (req, res) => {
    res.json(await service.stats(authOf(req)));
  });
  router.get("/:id", auth.requirePermission("leads:read"), async (req, res) => {
    res.json(await service.get(authOf(req), idOf(req.params.id)));
  });
  router.post("/", auth.requirePermission("leads:write"), async (req, res) => {
    res.status(201).json(await service.create(authOf(req), parse(createSchema, req.body), req.ip));
  });
  router.patch("/:id", auth.requirePermission("leads:write"), async (req, res) => {
    res.json(await service.update(authOf(req), idOf(req.params.id), parse(patchSchema, req.body), req.ip));
  });
  router.post("/:id/transition", auth.requirePermission("leads:write"), async (req, res) => {
    const result = await service.transition(authOf(req), idOf(req.params.id), parse(transitionSchema, req.body), req.ip);
    if (result.conversion?.emailQueued) deps.onEmailQueued?.();
    res.json(result);
  });
  router.post("/:id/notes", auth.requirePermission("leads:write"), async (req, res) => {
    await service.addNote(authOf(req), idOf(req.params.id), parse(noteSchema, req.body).note);
    res.status(201).end();
  });
  router.delete("/:id", auth.requirePermission("leads:delete"), async (req, res) => {
    await service.remove(authOf(req), idOf(req.params.id), req.ip);
    res.status(204).end();
  });
  return router;
}
