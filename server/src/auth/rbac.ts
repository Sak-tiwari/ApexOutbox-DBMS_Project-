/**
 * Role-based access control. The SERVER enforces this on every route; the UI only uses
 * `permissions` (returned by GET /api/me) to decide which menus and buttons to show.
 */
export const ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "leads:read"
  | "leads:write"
  | "leads:delete"
  | "scrape:run"
  | "scrape:manage_domains"
  | "clients:read"
  | "clients:write"
  | "invoices:read"
  | "invoices:manage"
  | "users:read"
  | "users:manage"
  | "tenant:settings"
  | "audit:read"
  | "data:export"
  | "tenant:delete";

const MEMBER: Permission[] = ["leads:read", "leads:write", "scrape:run", "clients:read", "invoices:read", "users:read"];
const ADMIN: Permission[] = [
  ...MEMBER,
  "leads:delete",
  "scrape:manage_domains",
  "clients:write",
  "invoices:manage",
  "users:manage",
  "tenant:settings",
  "audit:read",
  "data:export",
];
const OWNER: Permission[] = [...ADMIN, "tenant:delete"];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  MEMBER: new Set(MEMBER),
  ADMIN: new Set(ADMIN),
  OWNER: new Set(OWNER),
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]].sort();
}

/**
 * Who may manage whom (create, change the role of, reset, remove):
 *   OWNER -> anyone (including other owners)
 *   ADMIN -> members only
 *   MEMBER -> nobody
 */
export function canManageRole(actor: Role, target: Role): boolean {
  if (actor === "OWNER") return true;
  if (actor === "ADMIN") return target === "MEMBER";
  return false;
}
