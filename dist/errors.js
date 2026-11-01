"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReasonRequiredError = exports.InvalidTransitionError = exports.ConflictError = exports.NotFoundError = exports.ForbiddenError = exports.UnauthenticatedError = exports.ValidationError = exports.AppError = void 0;
/**
 * Typed application errors. HTTP status and error code travel with the error,
 * so routes never have to guess from message text.
 * Message prefixes ("Invalid Pipeline Transition", "Concurrency Conflict", "Reopening Guard")
 * are kept identical to Phase 3 so its existing tests still match.
 */
class AppError extends Error {
    code;
    status;
    details;
    constructor(code, message, status, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
        this.name = new.target.name;
    }
}
exports.AppError = AppError;
class ValidationError extends AppError {
    constructor(message, details, code = "VALIDATION_ERROR") {
        super(code, message, 400, details);
    }
}
exports.ValidationError = ValidationError;
class UnauthenticatedError extends AppError {
    constructor(message = "Missing or invalid credentials") {
        super("UNAUTHENTICATED", message, 401);
    }
}
exports.UnauthenticatedError = UnauthenticatedError;
class ForbiddenError extends AppError {
    constructor(message) {
        super("FORBIDDEN", message, 403);
    }
}
exports.ForbiddenError = ForbiddenError;
class NotFoundError extends AppError {
    constructor(message = "Not found") {
        super("NOT_FOUND", message, 404);
    }
}
exports.NotFoundError = NotFoundError;
class ConflictError extends AppError {
    constructor(message) {
        super("VERSION_CONFLICT", message, 409);
    }
}
exports.ConflictError = ConflictError;
class InvalidTransitionError extends AppError {
    constructor(message, allowed) {
        super("INVALID_TRANSITION", message, 422, { allowed });
    }
}
exports.InvalidTransitionError = InvalidTransitionError;
class ReasonRequiredError extends AppError {
    constructor(message) {
        super("REASON_REQUIRED", message, 422);
    }
}
exports.ReasonRequiredError = ReasonRequiredError;
//# sourceMappingURL=errors.js.map