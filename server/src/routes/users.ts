import { Router } from "express";
import { z } from "zod";
import { ROLES } from "../auth/rbac.js";
import { isUuid } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { limitSchema } from "../http/pagination.js";
import { parse } from "../http/validate.js";
import { authOf, type AuthMiddleware } from "../middleware/auth.js";
import type { UsersService } from "../users/service.js";

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(100),
  role: z.enum(ROLES),
});
const patchSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional(), role: z.enum(ROLES).optional() })
  .refine((v) => v.name !== undefined || v.role !== undefined, "Nothing to update");
const listSchema = z.object({ limit: limitSchema, cursor: z.string().max(500).optional() });

/** A malformed id is "not found", the same answer as an id that belongs to another tenant. */
const idOf = (raw: string | string[] | undefined) => {
  if (typeof raw !== "string" || !isUuid(raw)) throw new NotFoundError("User not found");
  return raw;
};

export function createUsersRouter(deps: { service: UsersService; auth: AuthMiddleware }) {
  const { service, auth } = deps;
  const router = Router();
  router.use(auth.requireAuth());

  router.get("/", auth.requirePermission("users:read"), async (req, res) => {
    res.json(await service.list(authOf(req), parse(listSchema, req.query, "Query")));
  });

  router.post("/", auth.requirePermission("users:manage"), async (req, res) => {
    const result = await service.create(authOf(req), parse(createSchema, req.body), req.ip);
    res.status(201).json(result);
  });

  router.patch("/:id", auth.requirePermission("users:manage"), async (req, res) => {
    res.json(await service.update(authOf(req), idOf(req.params.id), parse(patchSchema, req.body), req.ip));
  });

  router.delete("/:id", auth.requirePermission("users:manage"), async (req, res) => {
    await service.remove(authOf(req), idOf(req.params.id), req.ip);
    res.status(204).end();
  });

  router.post("/:id/reset-password", auth.requirePermission("users:manage"), async (req, res) => {
    res.json(await service.resetPassword(authOf(req), idOf(req.params.id), req.ip));
  });

  return router;
}
