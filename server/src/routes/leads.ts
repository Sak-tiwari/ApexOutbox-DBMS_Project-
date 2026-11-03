import { Router } from "express";
import { z } from "zod";
import { LEAD_STATUSES } from "../domain/pipeline.js";
import { isUuid } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { limitSchema } from "../http/pagination.js";
import { parse } from "../http/validate.js";
import { LeadsService } from "../leads/service.js";
import { authOf, type AuthMiddleware } from "../middleware/auth.js";

// Free text: trimmed, control characters stripped. Output escaping is the UI's job; we never store markup-significant tricks as "safe".
// eslint-disable-next-line no-control-regex
const clean = (max: number) => z.string().transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim()).pipe(z.string().min(1).max(max));
const optionalText = (max: number) => z.union([clean(max), z.literal("").transform(() => null), z.null()]);

const email = z.string().trim().toLowerCase().email().max(254);
const phone = z.string().trim().regex(/^[0-9+().\-\s]{5,40}$/, "Digits, spaces and + ( ) - only");
/** Only http(s) URLs are accepted, so a lead's website can never be a javascript: or data: link. */
const website = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && u.hostname.includes(".");
    } catch {
      return false;
    }
  }, "Must be a valid http(s) website");
const nullable = <T extends z.ZodType>(s: T) => z.union([s, z.literal("").transform(() => null), z.null()]);

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
const transitionSchema = z.object({ to: z.enum(LEAD_STATUSES), version: z.number().int().min(0), reason: z.string().trim().max(1000).optional() }).strict();
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

export function createLeadsRouter(deps: { service: LeadsService; auth: AuthMiddleware }) {
  const { service, auth } = deps;
  const router = Router();
  router.use(auth.requireAuth());

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
    res.json(await service.transition(authOf(req), idOf(req.params.id), parse(transitionSchema, req.body), req.ip));
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
