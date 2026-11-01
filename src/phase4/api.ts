import { Router } from "express";
import { onboardingSchema } from "./onboarding";
import { onboardClient } from "./onboardingService";
import { ValidationError } from "../errors";

/**
 * Direct onboarding endpoint (kept from Phase 4). It is now a router mounted by the unified app
 * behind API-key authentication; the normal path is the Closed-Won hand-off from Phase 3.
 */
export function createOnboardingRouter(): Router {
  const router = Router();

  router.post("/onboard", async (req, res, next) => {
    try {
      const parsed = onboardingSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid onboarding data", parsed.error.issues);
      }
      const result = await onboardClient(parsed.data);
      return res.status(202).json({ message: "Onboarding accepted for processing", ...result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
