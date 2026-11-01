"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOnboardingRouter = createOnboardingRouter;
const express_1 = require("express");
const onboarding_1 = require("./onboarding");
const onboardingService_1 = require("./onboardingService");
const errors_1 = require("../errors");
/**
 * Direct onboarding endpoint (kept from Phase 4). It is now a router mounted by the unified app
 * behind API-key authentication; the normal path is the Closed-Won hand-off from Phase 3.
 */
function createOnboardingRouter() {
    const router = (0, express_1.Router)();
    router.post("/onboard", async (req, res, next) => {
        try {
            const parsed = onboarding_1.onboardingSchema.safeParse(req.body);
            if (!parsed.success) {
                throw new errors_1.ValidationError("Invalid onboarding data", parsed.error.issues);
            }
            const result = await (0, onboardingService_1.onboardClient)(parsed.data);
            return res.status(202).json({ message: "Onboarding accepted for processing", ...result });
        }
        catch (error) {
            next(error);
        }
    });
    return router;
}
//# sourceMappingURL=api.js.map