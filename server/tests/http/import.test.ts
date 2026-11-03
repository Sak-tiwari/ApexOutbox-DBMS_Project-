import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { CsvFormatError, parseCsv, validateRows } from "../../src/leads/csv.js";
import { bearer, makeApp, newAccount, userWithRole } from "../helpers/app.js";
import { closePools, ownerPool } from "../helpers/db.js";

afterAll(closePools);

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, embedded commas/newlines, CRLF, BOM and blank lines", () => {
    const text = '﻿name,company\r\n"Smith, John","He said ""hi"""\r\n\r\n"Multi\nline",Acme\r\n';
    expect(parseCsv(text)).toEqual([["name", "company"], ["Smith, John", 'He said "hi"'], ["Multi\nline", "Acme"]]);
  });
  it("keeps a final row without a trailing newline and empty cells", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([["a", "b", "c"], ["1", "", "3"]]);
  });
  it("refuses unterminated quotes, too many rows/columns, and huge cells", () => {
    expect(() => parseCsv('a\n"never closed')).toThrow(CsvFormatError);
    expect(() => parseCsv("a\n" + "x\n".repeat(1001))).toThrow(/rows/);
    expect(() => parseCsv(Array.from({ length: 21 }, (_, i) => `c${i}`).join(","))).toThrow(/columns/);
    expect(() => parseCsv("a\n" + "x".repeat(1001))).toThrow(/longer/);
  });
});

describe("validateRows", () => {
  it("maps header aliases case-insensitively and reports bad rows with line numbers", () => {
    const { rows, errors, total } = validateRows(parseCsv(
      "Company Name,E-mail,Mobile,URL\nAcme Ltd,SALES@Acme.example.com,+91 98765 43210,acme.example.com\nBad Co,not-an-email,,\nNo Phone Co,,12,\n",
    ));
    expect(total).toBe(3);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ name: "Acme Ltd", companyName: "Acme Ltd", email: "sales@acme.example.com", dedupeKey: "domain:acme.example.com" });
    expect(errors.map((e) => e.row)).toEqual([3, 4]);
    expect(errors[0]!.message).toMatch(/^email/);
  });
  it("rejects cells that could run as spreadsheet formulas", () => {
    const { rows, errors } = validateRows(parseCsv('name,email\n=HYPERLINK("http://evil"),a@b.example.com\n+cmd|x,\n-2+3,\n@SUM(1),\n"\tTab",\nFine Co,fine@fine.example.com\n'));
    expect(rows.map((r) => r.data.name)).toEqual(["Fine Co"]);
    expect(errors).toHaveLength(5);
    expect(errors.every((e) => /formula/.test(e.message))).toBe(true);
  });
  it("requires a name or company column and a non-empty file", () => {
    expect(() => validateRows(parseCsv("email,phone\na@b.example.com,12345"))).toThrow(/name/);
    expect(() => validateRows([])).toThrow(/empty/);
  });
  it("rejects dangerous websites and phone numbers that look like formulas", () => {
    const { rows, errors } = validateRows(parseCsv("name,website,phone\nA,javascript:alert(1),\nB,,+1+1\nC,https://c.example.com,\n"));
    expect(rows.map((r) => r.data.name)).toEqual(["C"]);
    expect(errors).toHaveLength(2);
  });
});

describe("POST /api/leads/import", () => {
  const send = (ctx: ReturnType<typeof makeApp>, token: string, body: string, type = "text/csv") =>
    request(ctx.app).post("/api/leads/import").set(bearer(token)).set("Content-Type", type).send(body);
  const t = () => randomUUID().slice(0, 8);

  it("imports valid rows as the caller's leads, skips duplicates and bad rows, and reports exactly why", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "imp");
    const a = t(), b = t();
    const csv = `name,company,email,website\nAlice ${a},Alpha ${a},alice@alpha-${a}.example.com,alpha-${a}.example.com\n` +
      `Bob ${b},,,https://beta-${b}.example.com\nDup,,,https://www.alpha-${a}.example.com/x\n=EVIL(),,,\nNo Identity,,,\n`;
    const res = await send(ctx, owner.accessToken, csv);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ total: 5, inserted: 3, duplicates: 1, rejected: 1 });
    expect(res.body.errors).toEqual([
      { row: 4, message: "Duplicate: a lead for this business already exists" },
      { row: 5, message: expect.stringMatching(/formula/) },
    ]);
    const list = (await request(ctx.app).get("/api/leads?limit=50").set(bearer(owner.accessToken))).body.items;
    expect(list).toHaveLength(3);
    expect(list.every((l: { ownerId: string; sourceAdapter: string }) => l.ownerId === owner.userId && l.sourceAdapter === "csv")).toBe(true);
    expect(list.find((l: { name: string }) => l.name === "No Identity").needsReview).toBe(true);
    const audit = await ownerPool().query("SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'lead.csv_imported'", [owner.tenantId]);
    expect(audit.rows[0].metadata).toEqual({ inserted: 3, duplicates: 1, rejected: 1 });
  });

  it("re-uploading the same file inserts nothing", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "imp2");
    const csv = `name,website\nOnly One,https://once-${t()}.example.com\n`;
    expect((await send(ctx, owner.accessToken, csv)).body.inserted).toBe(1);
    expect((await send(ctx, owner.accessToken, csv)).body).toMatchObject({ inserted: 0, duplicates: 1 });
  });

  it("rejects wrong content types, empty bodies, oversized files and malformed CSV", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "imp3");
    expect((await send(ctx, owner.accessToken, "name\nx", "application/json")).status).toBe(400); // JSON parser rejects non-JSON before the route
    expect((await send(ctx, owner.accessToken, "")).status).toBe(415);
    const big = await send(ctx, owner.accessToken, "name\n" + "a".repeat(600_000));
    expect(big.status).toBe(413);
    const bad = await send(ctx, owner.accessToken, 'name\n"open');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_CSV");
    expect((await send(ctx, owner.accessToken, "email\na@b.example.com")).body.error.code).toBe("CSV_NO_NAME_COLUMN");
  });

  it("is open to members, closed to anonymous callers, and rate limited", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "imp4");
    const member = await userWithRole(ctx, owner.accessToken, "MEMBER");
    expect((await send(ctx, member.accessToken, `name,website\nM,https://m-${t()}.example.com`)).status).toBe(201);
    expect((await request(ctx.app).post("/api/leads/import").set("Content-Type", "text/csv").send("name\nx")).status).toBe(401);
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await send(ctx, member.accessToken, "name\nx")).status;
    expect(last).toBe(429);
  });

  it("imported leads stay inside the importing workspace", async () => {
    const ctx = makeApp();
    const a = await newAccount(ctx, "impA");
    const b = await newAccount(ctx, "impB");
    const site = `https://shared-${t()}.example.com`;
    await send(ctx, a.accessToken, `name,website\nShared,${site}`);
    expect((await send(ctx, b.accessToken, `name,website\nShared,${site}`)).body.inserted).toBe(1);
    expect((await request(ctx.app).get("/api/leads").set(bearer(b.accessToken))).body.items).toHaveLength(1);
  });
});
