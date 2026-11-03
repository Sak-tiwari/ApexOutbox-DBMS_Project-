import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  checkPasswordPolicy, generateTemporaryPassword, hashPassword, needsRehash, verifyAgainstDummy, verifyPassword,
} from "../../src/auth/password.js";
import { ROLES, canManageRole, can, permissionsFor, type Permission } from "../../src/auth/rbac.js";
import { hashToken, newOpaqueToken, signAccessToken, verifyAccessToken, signTwoFactorChallenge, verifyTwoFactorChallenge } from "../../src/auth/tokens.js";
import {
  base32Decode, base32Encode, decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret,
  hashRecoveryCode, normalizeRecoveryCode, otpauthUri, totpCode, verifyTotp,
} from "../../src/auth/totp.js";
import { testConfig } from "../helpers/app.js";

describe("password hashing (Argon2id)", () => {
  it("hashes with argon2id, salts each hash, and verifies", async () => {
    const a = await hashPassword("Correct-Horse-Battery-9");
    const b = await hashPassword("Correct-Horse-Battery-9");
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "Correct-Horse-Battery-9")).toBe(true);
    expect(await verifyPassword(a, "Correct-Horse-Battery-8")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });

  it("flags weaker legacy parameters for re-hashing", async () => {
    const argon2 = (await import("argon2")).default;
    const weak = await argon2.hash("Correct-Horse-Battery-9", { type: argon2.argon2id, memoryCost: 4096, timeCost: 1, parallelism: 1 });
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(await hashPassword("Correct-Horse-Battery-9"))).toBe(false);
  });

  it("the dummy verification always fails but takes real hashing time", async () => {
    await verifyAgainstDummy("warm-up");
    const t = Date.now();
    expect(await verifyAgainstDummy("anything")).toBe(false);
    expect(Date.now() - t).toBeGreaterThanOrEqual(5);
  });
});

describe("password policy", () => {
  const ok = (p: string, ctx = {}) => checkPasswordPolicy(p, ctx);

  it("accepts a strong password", () => {
    expect(ok("Correct-Horse-Battery-9")).toEqual([]);
    expect(ok("a long passphrase of plain words only")).toEqual([]); // 20+ chars needs no character classes
  });

  it.each([
    ["too short", "Ab1!xyz"],
    ["only two character classes (12-19 chars)", "alllowercase99"],
    ["common password", "Password123!"],
    ["common with symbols stripped", "p@ssw0rd1234"],
    ["4 identical characters in a row", "Zebra-Coffee-aaaa-9"],
  ])("rejects %s", (_name, password) => {
    expect(ok(password).length).toBeGreaterThan(0);
  });

  it("rejects passwords over 128 characters", () => {
    expect(ok(`Aa1!${"x1Y".repeat(50)}`).join(" ")).toMatch(/at most 128/);
  });

  it("rejects a password containing the e-mail name or the person's name", () => {
    expect(ok("Sunflower-priyasharma-7!", { email: "priyasharma@example.com" }).join(" ")).toMatch(/name or e-mail/);
    expect(ok("Winter-Kowalski-2026!", { name: "Anna Kowalski" }).join(" ")).toMatch(/name or e-mail/);
    expect(ok("Winter-Ann-2026-Blue!", { name: "Ann Lee" })).toEqual([]); // short name parts are ignored
  });

  it("generated temporary passwords always satisfy the policy and are unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(checkPasswordPolicy(p)).toEqual([]);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});

describe("TOTP (RFC 6238)", () => {
  // Official test vectors, RFC 6238 Appendix B. 8 digits, time in seconds.
  const sha1 = base32Encode(Buffer.from("12345678901234567890"));
  const sha256 = base32Encode(Buffer.from("12345678901234567890123456789012"));
  const sha512 = base32Encode(Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"));

  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("SHA-1 vector at T=%i is %s", (t, expected) => {
    expect(totpCode(sha1, t * 1000, { digits: 8 })).toBe(expected);
  });

  it("SHA-256 and SHA-512 vectors at T=59", () => {
    expect(totpCode(sha256, 59_000, { digits: 8, algorithm: "sha256" })).toBe("46119246");
    expect(totpCode(sha512, 59_000, { digits: 8, algorithm: "sha512" })).toBe("90693936");
  });

  it("6-digit codes are the last six digits of the 8-digit vectors", () => {
    expect(totpCode(sha1, 59_000)).toBe("287082");
    expect(totpCode(sha1, 1111111109_000)).toBe("081804");
  });

  it("base32 round-trips arbitrary bytes", () => {
    for (let n = 0; n < 40; n++) {
      const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 255));
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
    expect(() => base32Decode("not*base32")).toThrow();
  });

  it("accepts the current code and one step of clock drift, nothing more", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpCode(secret, now), now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 90_000), now)).toBeNull();
  });

  it("refuses to accept the same time step twice (replay protection)", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = totpCode(secret, now);
    const step = verifyTotp(secret, code, now, null);
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now, step)).not.toBeNull(); // the next step is fine
  });

  it("rejects malformed codes", () => {
    const secret = generateTotpSecret();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 345", "１２３４５６"]) {
      expect(verifyTotp(secret, bad, Date.now())).toBeNull();
    }
  });

  it("builds an otpauth URI for authenticator apps", () => {
    const uri = otpauthUri("ApexOutbox", "a@b.example", "JBSWY3DPEHPK3PXP");
    expect(uri).toBe("otpauth://totp/ApexOutbox:a%40b.example?secret=JBSWY3DPEHPK3PXP&issuer=ApexOutbox&algorithm=SHA1&digits=6&period=30");
  });

  it("encrypts secrets at rest with AES-256-GCM (random IV, tamper-evident, wrong key fails)", () => {
    const key = Buffer.alloc(32, 9);
    const stored = encryptSecret(key, "JBSWY3DPEHPK3PXP");
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain("JBSWY3DPEHPK3PXP");
    expect(encryptSecret(key, "JBSWY3DPEHPK3PXP")).not.toBe(stored);
    expect(decryptSecret(key, stored)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptSecret(Buffer.alloc(32, 1), stored)).toThrow();
    const parts = stored.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(key, parts.join("."))).toThrow();
  });

  it("recovery codes: 8 unique, hashed case/format-insensitively", () => {
    const codes = generateRecoveryCodes(8);
    expect(new Set(codes).size).toBe(8);
    expect(codes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c))).toBe(true);
    const c = codes[0]!;
    expect(hashRecoveryCode(c.toUpperCase())).toBe(hashRecoveryCode(c));
    expect(hashRecoveryCode(` ${c.replace("-", " ")} `)).toBe(hashRecoveryCode(c));
    expect(normalizeRecoveryCode("AB-cd e")).toBe("abcde");
  });
});

describe("tokens", () => {
  const config = testConfig();
  const claims = { userId: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222", role: "ADMIN" as const };

  it("round-trips access-token claims", async () => {
    expect(await verifyAccessToken(config, await signAccessToken(config, claims))).toEqual(claims);
  });

  it("rejects tokens signed with another secret, tampered tokens, and garbage", async () => {
    const other = testConfig({ JWT_ACCESS_SECRET: "a-completely-different-secret-0123456789abcdef!!" });
    await expect(verifyAccessToken(config, await signAccessToken(other, claims))).rejects.toThrow(/Invalid or expired/);
    const good = await signAccessToken(config, claims);
    const [h, p, s] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), role: "OWNER" })).toString("base64url");
    await expect(verifyAccessToken(config, `${h}.${forged}.${s}`)).rejects.toThrow();
    await expect(verifyAccessToken(config, "not.a.jwt")).rejects.toThrow();
  });

  it('rejects an unsigned "alg: none" token', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub: claims.userId, tid: claims.tenantId, role: "OWNER", typ: "access", iss: "apexoutbox", aud: "apexoutbox-api", exp: 9999999999 })}.`;
    await expect(verifyAccessToken(config, none)).rejects.toThrow();
  });

  it("rejects expired tokens and tokens meant for another purpose or audience", async () => {
    const key = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
    const build = (extra: Record<string, unknown>, aud = "apexoutbox-api", exp: number | string = "10m") =>
      new SignJWT({ tid: claims.tenantId, role: "ADMIN", typ: "access", ...extra }).setProtectedHeader({ alg: "HS256" })
        .setSubject(claims.userId).setIssuer("apexoutbox").setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(key);
    await expect(verifyAccessToken(config, await build({}, "apexoutbox-api", Math.floor(Date.now() / 1000) - 60))).rejects.toThrow();
    await expect(verifyAccessToken(config, await build({}, "someone-else"))).rejects.toThrow();
    await expect(verifyAccessToken(config, await build({ typ: "2fa" }))).rejects.toThrow();
    await expect(verifyAccessToken(config, await build({ role: "SUPERUSER" }))).rejects.toThrow();
  });

  it("a 2FA challenge cannot be used as an access token, and vice versa", async () => {
    const challenge = await signTwoFactorChallenge(config, claims.userId, claims.tenantId);
    await expect(verifyAccessToken(config, challenge)).rejects.toThrow();
    await expect(verifyTwoFactorChallenge(config, await signAccessToken(config, claims))).rejects.toThrow();
    expect(await verifyTwoFactorChallenge(config, challenge)).toEqual({ userId: claims.userId, tenantId: claims.tenantId });
  });

  it("opaque tokens are 256-bit random and only their hash is comparable", () => {
    const a = newOpaqueToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(newOpaqueToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
  });
});

describe("RBAC matrix", () => {
  const perms: Permission[] = [
    "leads:read", "leads:write", "leads:delete", "scrape:run", "scrape:manage_domains", "clients:read", "clients:write",
    "invoices:read", "invoices:manage", "users:read", "users:manage", "tenant:settings", "audit:read", "data:export", "tenant:delete",
  ];

  it("MEMBER can work leads and read, but not administer", () => {
    for (const p of ["leads:read", "leads:write", "scrape:run", "clients:read", "invoices:read", "users:read"] as Permission[]) expect(can("MEMBER", p), p).toBe(true);
    for (const p of ["leads:delete", "scrape:manage_domains", "clients:write", "invoices:manage", "users:manage", "tenant:settings", "audit:read", "data:export", "tenant:delete"] as Permission[]) expect(can("MEMBER", p), p).toBe(false);
  });

  it("ADMIN can do everything except delete the workspace", () => {
    for (const p of perms) expect(can("ADMIN", p), p).toBe(p !== "tenant:delete");
  });

  it("OWNER can do everything", () => {
    for (const p of perms) expect(can("OWNER", p), p).toBe(true);
  });

  it("each role's permissions are a superset of the one below", () => {
    expect(permissionsFor("MEMBER").every((p) => can("ADMIN", p))).toBe(true);
    expect(permissionsFor("ADMIN").every((p) => can("OWNER", p))).toBe(true);
  });

  it("management rules: owner manages all, admin only members, member nobody", () => {
    const table = Object.fromEntries(ROLES.map((actor) => [actor, ROLES.filter((t) => canManageRole(actor, t))]));
    expect(table).toEqual({ OWNER: ["OWNER", "ADMIN", "MEMBER"], ADMIN: ["MEMBER"], MEMBER: [] });
  });
});
