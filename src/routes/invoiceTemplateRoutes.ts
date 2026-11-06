import { Router, type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import { z } from "zod";
import { AppError, NotFoundError, ValidationError } from "../errors";
import { builderSchema, type BuilderOptions, builderBrand, builderSource } from "../invoiceTemplates/builder";
import { BUILTINS, builtinVersionId, exampleTemplatePath, isBuiltin } from "../invoiceTemplates/builtins";
import { docxToTemplateHtml } from "../invoiceTemplates/docx";
import { renderTemplateHtml, validateTemplate, type ValidationIssue } from "../invoiceTemplates/engine";
import { GST_RATES, GSTIN_RE, STATES } from "../invoiceTemplates/gst";
import { viewDataFor } from "../invoiceTemplates/invoicePdf";
import { PLACEHOLDERS, REQUIRED_FIELDS } from "../invoiceTemplates/placeholders";
import { htmlToPdf } from "../invoiceTemplates/renderer";
import { sanitizeTemplateHtml } from "../invoiceTemplates/sanitize";
import { TemplateError, type InvoiceTemplateStore, type Renderable } from "../invoiceTemplates/store";
import { sampleSnapshot } from "../invoiceTemplates/viewModel";
import type { InvoiceSnapshot } from "../phase4/types";

/** A real invoice the caller owns, for previews and regeneration. */
export interface OwnedInvoice { id: string; number: string; status: string; snapshot: InvoiceSnapshot }
export interface InvoiceAccess {
  /** Returns the invoice only when it belongs to ownerId. */
  get(ownerId: string, invoiceId: string): Promise<OwnedInvoice | null>;
  list(ownerId: string, limit: number): Promise<Array<{ id: string; number: string; clientName: string }>>;
  /** Re-renders the PDF (does not send the email again). Records the new template version when one is given. */
  regenerate(ownerId: string, invoiceId: string, templateVersionId?: string): Promise<{ fallback: boolean; usedVersionId: string }>;
}

export interface InvoiceTemplateRouterDeps {
  store: InvoiceTemplateStore;
  invoices: InvoiceAccess;
  toPdf?: (html: string) => Promise<Buffer>;
}

const text = (max: number) => z.string().trim().max(max).optional();
const businessBody = z.object({
  name: text(120), address: text(500), state: z.union([z.literal(""), z.enum(STATES as [string, ...string[]])]).optional(),
  gstin: z.union([z.literal(""), z.string().trim().toUpperCase().regex(GSTIN_RE, "GSTIN must be 15 characters, e.g. 27ABCDE1234F1Z5")]).optional(),
  email: z.union([z.literal(""), z.string().trim().email("Enter a valid email")]).optional(), phone: text(30),
  logoAssetId: text(24), qrAssetId: text(24),
  bankName: text(80), account: z.union([z.literal(""), z.string().trim().regex(/^[0-9]{6,18}$/, "Account number: 6-18 digits")]).optional(),
  ifsc: z.union([z.literal(""), z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC looks like HDFC0001234")]).optional(),
  upiId: z.union([z.literal(""), z.string().trim().regex(/^[\w.-]{2,}@[a-zA-Z]{2,}$/, "UPI ID looks like name@bank")]).optional(),
  paymentLink: z.union([z.literal(""), z.string().trim().url().max(300).refine((u) => /^https:\/\//i.test(u), "Payment link must start with https://")]).optional(),
  defaultGstRate: z.number().refine((n) => (GST_RATES as readonly number[]).includes(n), "GST rate must be 0, 5, 12, 18 or 28").optional(),
  terms: text(1000),
}).strict();

const nameSchema = z.string().trim().min(1, "Give the template a name").max(80);
const createBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("html"), name: nameSchema, source: z.string().max(500_000).optional(), fileBase64: z.string().max(7_000_000).optional() }),
  z.object({ type: z.literal("docx"), name: nameSchema, fileBase64: z.string().min(1).max(7_000_000), fileName: z.string().max(120).optional() }),
  z.object({ type: z.literal("builder"), name: nameSchema, builder: builderSchema }),
]);
const updateBody = z.object({ name: nameSchema.optional(), source: z.string().max(500_000).optional(), builder: builderSchema.optional() }).strict();
const previewBody = z.object({
  format: z.enum(["html", "pdf"]).default("html"),
  invoiceId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  /** Unsaved edits from the editor; previewed without saving. */
  source: z.string().max(500_000).optional(),
  builder: builderSchema.optional(),
}).strict();
const assetBody = z.object({ name: z.string().trim().min(1).max(120), dataBase64: z.string().min(1).max(7_000_000) }).strict();

const MAX_FILE = 5 * 1024 * 1024;
function decode(b64: string): Buffer {
  const buf = Buffer.from(b64.replace(/^data:[^,]*,/, ""), "base64");
  if (buf.length > MAX_FILE) throw new AppError("PAYLOAD_TOO_LARGE", "Files can be at most 5 MB", 413);
  return buf;
}
const invalid = (e: z.ZodError) => new ValidationError(e.issues[0]?.message ?? "Invalid request", e.issues);
const fail = (issues: ValidationIssue[]) => { const e = new ValidationError(issues.find((i) => i.level === "error")?.message ?? "Template is not valid", issues); return e; };

export function createInvoiceTemplateRouter(deps: InvoiceTemplateRouterDeps): Router {
  const { store } = deps;
  const toPdf = deps.toPdf ?? ((h: string) => htmlToPdf(h));
  const router = Router();
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((e) => next(e instanceof TemplateError ? new AppError(e.status === 404 ? "NOT_FOUND" : e.status === 409 ? "CONFLICT" : e.status === 413 ? "PAYLOAD_TOO_LARGE" : e.status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "VALIDATION_ERROR", e.message, e.status) : e));
  };
  const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });
  const owner = (req: Request) => req.userId!;

  /** Clean and check a template source; throws 400 with every problem listed. */
  async function prepareHtml(ownerId: string, raw: string): Promise<{ source: string; issues: ValidationIssue[] }> {
    const v0 = validateTemplate(raw, { assetNames: await store.assetNames(ownerId) });
    const source = sanitizeTemplateHtml(raw);
    const v = validateTemplate(source, { assetNames: await store.assetNames(ownerId) });
    const issues = [...v.issues, ...v0.issues.filter((i) => i.level === "warning")];
    if (!v.ok) throw fail(issues);
    return { source, issues };
  }

  // ---------- reference ----------
  router.get("/placeholders", (_req, res) => ok(res, { groups: PLACEHOLDERS, required: REQUIRED_FIELDS, states: STATES, gstRates: GST_RATES, builtins: BUILTINS.map((b) => ({ id: b.id, name: b.name })) }));
  router.get("/example", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="apexoutbox-example-template.html"');
    res.send(fs.readFileSync(exampleTemplatePath(), "utf8"));
  });

  // ---------- business details ----------
  router.get("/business", wrap(async (req, res) => ok(res, await store.getBusiness(owner(req)))));
  router.put("/business", wrap(async (req, res) => {
    const p = businessBody.safeParse(req.body);
    if (!p.success) throw invalid(p.error);
    for (const k of ["logoAssetId", "qrAssetId"] as const) {
      const id = p.data[k];
      if (id && !(await store.readAsset(owner(req), id))) throw new ValidationError(`${k === "logoAssetId" ? "Logo" : "QR code"} file not found. Upload it first.`);
    }
    return ok(res, await store.saveBusiness(owner(req), p.data as any));
  }));

  // ---------- assets ----------
  router.get("/assets", wrap(async (req, res) => ok(res, await store.listAssets(owner(req)))));
  router.post("/assets", wrap(async (req, res) => {
    const p = assetBody.safeParse(req.body);
    if (!p.success) throw invalid(p.error);
    return ok(res, await store.saveAsset(owner(req), p.data.name, decode(p.data.dataBase64)), 201);
  }));
  router.get("/assets/:id", wrap(async (req, res) => {
    const a = await store.readAsset(owner(req), String(req.params.id));
    if (!a) throw new NotFoundError("File not found");
    return ok(res, { name: a.name, mime: a.mime, dataUri: a.mime.startsWith("image/") ? `data:${a.mime};base64,${a.data.toString("base64")}` : null });
  }));
  router.delete("/assets/:id", wrap(async (req, res) => { await store.deleteAsset(owner(req), String(req.params.id)); return ok(res, { removed: true }); }));

  // ---------- templates ----------
  router.get("/", wrap(async (req, res) => ok(res, await store.list(owner(req)))));
  router.post("/validate", wrap(async (req, res) => {
    const p = z.object({ source: z.string().max(500_000) }).safeParse(req.body);
    if (!p.success) throw invalid(p.error);
    const clean = sanitizeTemplateHtml(p.data.source);
    const v = validateTemplate(clean, { assetNames: await store.assetNames(owner(req)) });
    const warn = validateTemplate(p.data.source).issues.filter((i) => i.level === "warning");
    return ok(res, { ...v, issues: [...v.issues, ...warn], sanitizedChanged: clean.replace(/\s+/g, "") !== p.data.source.replace(/\s+/g, "") });
  }));
  router.post("/", wrap(async (req, res) => {
    const p = createBody.safeParse(req.body);
    if (!p.success) throw invalid(p.error);
    const b = p.data;
    if (b.type === "builder") return ok(res, await store.create(owner(req), { name: b.name, type: "builder", source: builderSource(b.builder), builder: b.builder }), 201);
    if (b.type === "docx") {
      const buf = decode(b.fileBase64);
      const original = await store.saveAsset(owner(req), (b.fileName || `${b.name}.docx`).replace(/\.docx$/i, "") + ".docx", buf);
      const { html, warnings } = await docxToTemplateHtml(buf);
      const { source, issues } = await prepareHtml(owner(req), html);
      const t = await store.create(owner(req), { name: b.name, type: "docx", source, originalAssetId: original.id });
      return res.status(201).json({ success: true, data: t, issues, conversionWarnings: warnings });
    }
    const raw = b.source ?? (b.fileBase64 ? decode(b.fileBase64).toString("utf8") : "");
    if (!raw.trim()) throw new ValidationError("Paste the template HTML or upload an .html file");
    const { source, issues } = await prepareHtml(owner(req), raw);
    const t = await store.create(owner(req), { name: b.name, type: "html", source });
    return res.status(201).json({ success: true, data: t, issues });
  }));
  router.get("/:id", wrap(async (req, res) => {
    const t = await store.get(owner(req), String(req.params.id));
    if (!t) throw new NotFoundError("Template not found");
    return ok(res, t);
  }));
  router.put("/:id", wrap(async (req, res) => {
    const p = updateBody.safeParse(req.body);
    if (!p.success) throw invalid(p.error);
    const id = String(req.params.id);
    if (isBuiltin(id)) throw new TemplateError("Built-in templates cannot be edited. Duplicate it first.", 409);
    const existing = await store.get(owner(req), id);
    if (!existing) throw new NotFoundError("Template not found");
    if (p.data.builder) {
      if (existing.type !== "builder") throw new ValidationError("This template was not made with the builder");
      return ok(res, await store.update(owner(req), id, { name: p.data.name, source: builderSource(p.data.builder), builder: p.data.builder }));
    }
    if (p.data.source !== undefined) {
      if (existing.type === "builder") throw new ValidationError("Builder templates are edited with the builder form");
      const { source, issues } = await prepareHtml(owner(req), p.data.source);
      const t = await store.update(owner(req), id, { name: p.data.name, source, originalAssetId: (existing.version as any).originalAssetId });
      return res.json({ success: true, data: t, issues });
    }
    return ok(res, await store.update(owner(req), id, { name: p.data.name }));
  }));
  router.delete("/:id", wrap(async (req, res) => { await store.remove(owner(req), String(req.params.id)); return ok(res, { removed: true }); }));
  router.post("/:id/default", wrap(async (req, res) => { await store.setDefault(owner(req), String(req.params.id)); return ok(res, { defaultTemplateId: String(req.params.id) }); }));
  router.post("/:id/duplicate", wrap(async (req, res) => ok(res, await store.duplicate(owner(req), String(req.params.id)), 201)));
  router.get("/:id/versions", wrap(async (req, res) => ok(res, (await store.versions(owner(req), String(req.params.id))).map((v) => ({ id: v.id, version: v.version, createdAt: v.createdAt, createdBy: v.createdBy, size: v.source.length })))));
  router.post("/:id/rollback", wrap(async (req, res) => {
    const p = z.object({ version: z.number().int().min(1) }).safeParse(req.body);
    if (!p.success) throw invalid(p.error);
    return ok(res, await store.rollback(owner(req), String(req.params.id), p.data.version));
  }));
  router.get("/:id/download", wrap(async (req, res) => {
    const t = await store.get(owner(req), String(req.params.id));
    if (!t) throw new NotFoundError("Template not found");
    const v = t.version as { source: string; originalAssetId?: string; builder?: BuilderOptions };
    const base = t.name.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-") || "template";
    if (t.type === "docx" && v.originalAssetId) {
      const f = await store.readAsset(owner(req), v.originalAssetId);
      if (f) { res.setHeader("Content-Type", f.mime); res.setHeader("Content-Disposition", `attachment; filename="${base}.docx"`); return res.send(f.data); }
    }
    if (t.type === "builder") { res.setHeader("Content-Disposition", `attachment; filename="${base}.json"`); return res.json(v.builder); }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.html"`);
    return res.send(v.source);
  }));

  /** Live preview: saved template, or the unsaved editor contents; sample data or one of the caller's invoices. */
  router.post("/:id/preview", wrap(async (req, res) => {
    const p = previewBody.safeParse(req.body ?? {});
    if (!p.success) throw invalid(p.error);
    const id = String(req.params.id);
    let r: Renderable;
    let issues: ValidationIssue[] = [];
    if (p.data.builder) r = { source: builderSource(p.data.builder), brand: builderBrand(p.data.builder), overrides: p.data.builder.overrides, versionId: "draft", name: "draft" };
    else if (p.data.source !== undefined) {
      const clean = sanitizeTemplateHtml(p.data.source);
      const v = validateTemplate(clean, { assetNames: await store.assetNames(owner(req)) });
      if (!v.ok) throw fail(v.issues);
      issues = [...v.issues, ...validateTemplate(p.data.source).issues.filter((i) => i.level === "warning")];
      r = { source: clean, versionId: "draft", name: "draft" };
    } else {
      const t = id === "new" ? null : await store.get(owner(req), id);
      if (!t) throw new NotFoundError("Template not found");
      r = await store.renderable(isBuiltin(id) ? builtinVersionId(id) : t.currentVersionId, owner(req));
    }

    let snapshot: InvoiceSnapshot, number: string, status = "PREVIEW";
    if (p.data.invoiceId) {
      const inv = await deps.invoices.get(owner(req), p.data.invoiceId);
      if (!inv) throw new NotFoundError("Invoice not found");
      snapshot = inv.snapshot; number = inv.number; status = inv.status;
    } else {
      const biz = await store.getBusiness(owner(req));
      snapshot = sampleSnapshot();
      // Show the user's own business details in the preview when they have filled them in.
      if (biz.name) snapshot.business = { ...snapshot.business!, ...Object.fromEntries(Object.entries(biz).filter(([k, v]) => v !== "" && k !== "defaultTemplateId" && k !== "defaultGstRate")) } as any;
      snapshot.ownerId = owner(req);
      number = snapshot.displayNumber!;
    }
    const { data, assets } = await viewDataFor(store, { ...snapshot, ownerId: owner(req) }, number, r, status);
    let html: string;
    try {
      html = renderTemplateHtml(r.source, data, assets);
    } catch (e) {
      throw new ValidationError(`The template could not be filled in: ${(e as Error).message.split("\n")[0]}`);
    }
    if (p.data.format === "html") return ok(res, { html, issues });
    const pdf = await toPdf(html).catch((e) => { throw new AppError("RENDER_FAILED", `PDF preview failed: ${(e as Error).message.split("\n")[0]}`, 503); });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="preview.pdf"');
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(pdf);
  }));

  // ---------- invoices (pick a real one for previews; regenerate with a template) ----------
  router.get("/invoices/mine", wrap(async (req, res) => ok(res, await deps.invoices.list(owner(req), 50))));
  router.post("/invoices/:invoiceId/regenerate", wrap(async (req, res) => {
    const p = z.object({ templateId: z.string().regex(/^(builtin:[a-z-]{1,30}|[a-f0-9]{24})$/).optional() }).strict().safeParse(req.body ?? {});
    if (!p.success) throw invalid(p.error);
    const inv = await deps.invoices.get(owner(req), String(req.params.invoiceId));
    if (!inv) throw new NotFoundError("Invoice not found");
    let versionId: string | undefined;
    if (p.data.templateId) {
      if (!(await store.list(owner(req))).some((t) => t.id === p.data.templateId)) throw new NotFoundError("Template not found");
      versionId = await store.resolveVersionId(owner(req), p.data.templateId);
    }
    return ok(res, await deps.invoices.regenerate(owner(req), inv.id, versionId));
  }));

  return router;
}
