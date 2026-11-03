/**
 * Typed application errors. Every error has a fixed HTTP status and a stable machine-readable code,
 * so clients never have to parse message text. Unknown errors become a generic 500 (detail is logged,
 * never sent to the client).
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = "Request validation failed", details?: unknown, code = "VALIDATION_ERROR") {
    super(400, code, message, details);
  }
}
export class UnauthenticatedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHENTICATED", message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do that", code = "FORBIDDEN") {
    super(403, code, message);
  }
}
/** Also used for rows that belong to another tenant: never reveal which of the two it was. */
export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "NOT_FOUND", message);
  }
}
export class ConflictError extends AppError {
  constructor(message: string, code = "CONFLICT", details?: unknown) {
    super(409, code, message, details);
  }
}
export class UnprocessableError extends AppError {
  constructor(message: string, code: string, details?: unknown) {
    super(422, code, message, details);
  }
}
export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests", public readonly retryAfterSeconds?: number) {
    super(429, "RATE_LIMITED", message);
  }
}
export class DependencyDownError extends AppError {
  constructor(message = "A required service is unavailable") {
    super(503, "DEPENDENCY_DOWN", message);
  }
}
