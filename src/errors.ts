/**
 * Typed application errors. HTTP status and error code travel with the error,
 * so routes never have to guess from message text.
 * Message prefixes ("Invalid Pipeline Transition", "Concurrency Conflict", "Reopening Guard")
 * are kept identical to Phase 3 so its existing tests still match.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown, code = "VALIDATION_ERROR") {
    super(code, message, 400, details);
  }
}
export class UnauthenticatedError extends AppError {
  constructor(message = "Missing or invalid credentials") {
    super("UNAUTHENTICATED", message, 401);
  }
}
export class ForbiddenError extends AppError {
  constructor(message: string) {
    super("FORBIDDEN", message, 403);
  }
}
export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("NOT_FOUND", message, 404);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super("VERSION_CONFLICT", message, 409);
  }
}
export class InvalidTransitionError extends AppError {
  constructor(message: string, allowed: readonly string[]) {
    super("INVALID_TRANSITION", message, 422, { allowed });
  }
}
export class ReasonRequiredError extends AppError {
  constructor(message: string) {
    super("REASON_REQUIRED", message, 422);
  }
}
