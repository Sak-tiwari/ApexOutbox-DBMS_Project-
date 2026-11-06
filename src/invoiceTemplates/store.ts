import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { builderBrand, builderSource, type BuilderOptions } from "./builder";
import { BUILTINS, builtinSource, builtinVersionId, isBuiltin, parseBuiltinVersionId } from "./builtins";
import { BusinessProfile, EMPTY_BUSINESS, InvoiceTemplate, InvoiceTemplateVersion, TemplateAsset, type BusinessInfo } from "./models";
import type { BrandOptions } from "./viewModel";

export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const ASSET_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2",
  ".css": "text/css", ".html": "text/html", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const MAX_ASSETS_PER_USER = 50;

export type TemplateType = "html" | "docx" | "builder";
export interface TemplateSummary {
  id: string; name: string; type: TemplateType | "builtin"; builtin: boolean; isDefault: boolean; currentVersion: number; currentVersionId: string; updatedAt?: Date; note?: string;
}
export interface VersionRecord { id: string; templateId: string; version: number; source: string; builder?: BuilderOptions; originalAssetId?: string; createdBy: string; createdAt: Date }
export interface Renderable { source: string; brand?: BrandOptions; overrides?: BuilderOptions["overrides"]; versionId: string; name: string }

const isId = (id: string) => mongoose.isValidObjectId(id) && /^[a-f0-9]{24}$/.test(id);
const toVersion = (d: any): VersionRecord => ({ id: String(d._id), templateId: d.templateId, version: d.version, source: d.source, builder: d.builder ?? undefined, originalAssetId: d.originalAssetId ?? undefined, createdBy: d.createdBy, createdAt: d.createdAt });

export class TemplateError extends Error { constructor(message: string, public status = 400) { super(message); } }

export class InvoiceTemplateStore {
  constructor(private assetDir: string) {}

  // ---------- business profile ----------
  async getBusiness(ownerId: string): Promise<BusinessInfo> {
    const d = await BusinessProfile.findOne({ ownerId }).lean<any>();
    if (!d) return { ...EMPTY_BUSINESS };
    const out = { ...EMPTY_BUSINESS };
    for (const k of Object.keys(EMPTY_BUSINESS) as Array<keyof BusinessInfo>) if (d[k] !== undefined && d[k] !== null) (out as any)[k] = d[k];
    if (!d.defaultChosen) out.defaultTemplateId = "builtin:technolites";
    return out;
  }
  async saveBusiness(ownerId: string, patch: Partial<BusinessInfo>): Promise<BusinessInfo> {
    const { defaultTemplateId: _ignored, ...rest } = patch;
    await BusinessProfile.updateOne({ ownerId }, { $set: rest, $setOnInsert: { ownerId } }, { upsert: true });
    return this.getBusiness(ownerId);
  }

  // ---------- templates ----------
  async list(ownerId: string): Promise<TemplateSummary[]> {
    const def = (await this.getBusiness(ownerId)).defaultTemplateId;
    const own = await InvoiceTemplate.find({ ownerId }).sort({ updatedAt: -1 }).limit(100).lean<any[]>();
    const ownIds = new Set(own.map((t) => String(t._id)));
    const effectiveDefault = isBuiltin(def) || ownIds.has(def) ? def : "builtin:technolites";
    return [
      ...BUILTINS.map((b) => ({ id: b.id, name: b.name, type: "builtin" as const, builtin: true, isDefault: effectiveDefault === b.id, currentVersion: 1, currentVersionId: builtinVersionId(b.id), note: b.note })),
      ...own.map((t) => ({ id: String(t._id), name: t.name, type: t.type, builtin: false, isDefault: effectiveDefault === String(t._id), currentVersion: t.currentVersion, currentVersionId: t.currentVersionId, updatedAt: t.updatedAt })),
    ];
  }
  async get(ownerId: string, id: string): Promise<(TemplateSummary & { version: VersionRecord | { source: string; version: number } }) | null> {
    const all = await this.list(ownerId);
    const t = all.find((x) => x.id === id);
    if (!t) return null;
    if (t.builtin) return { ...t, version: { source: builtinSource(id), version: 1 } };
    const v = await InvoiceTemplateVersion.findOne({ _id: t.currentVersionId, ownerId }).lean();
    return v ? { ...t, version: toVersion(v) } : null;
  }
  async create(ownerId: string, input: { name: string; type: TemplateType; source: string; builder?: BuilderOptions; originalAssetId?: string }): Promise<TemplateSummary> {
    if ((await InvoiceTemplate.countDocuments({ ownerId })) >= 100) throw new TemplateError("You have 100 templates already. Delete some first.", 409);
    const templateId = new mongoose.Types.ObjectId();
    const v = await InvoiceTemplateVersion.create({ templateId: String(templateId), ownerId, version: 1, source: input.source, builder: input.builder, originalAssetId: input.originalAssetId, createdBy: ownerId });
    await InvoiceTemplate.create({ _id: templateId, ownerId, name: input.name, type: input.type, currentVersionId: String(v._id), currentVersion: 1 });
    return (await this.list(ownerId)).find((t) => t.id === String(templateId))!;
  }
  /** Saving creates a new version. The old versions stay, so invoices made with them never change. */
  async update(ownerId: string, id: string, input: { name?: string; source?: string; builder?: BuilderOptions; originalAssetId?: string }): Promise<TemplateSummary> {
    if (isBuiltin(id)) throw new TemplateError("Built-in templates cannot be edited. Duplicate it first.", 409);
    if (!isId(id)) throw new TemplateError("Template not found", 404);
    const t = await InvoiceTemplate.findOne({ _id: id, ownerId }).lean<any>();
    if (!t) throw new TemplateError("Template not found", 404);
    if (input.source !== undefined) {
      const next = t.currentVersion + 1;
      let v;
      try {
        v = await InvoiceTemplateVersion.create({ templateId: id, ownerId, version: next, source: input.source, builder: input.builder, originalAssetId: input.originalAssetId, createdBy: ownerId });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) throw new TemplateError("Someone saved this template at the same time. Reload and try again.", 409);
        throw e;
      }
      const r = await InvoiceTemplate.updateOne({ _id: id, ownerId, currentVersion: t.currentVersion }, { $set: { currentVersion: next, currentVersionId: String(v._id), ...(input.name ? { name: input.name } : {}) } });
      if (r.modifiedCount === 0) throw new TemplateError("Someone saved this template at the same time. Reload and try again.", 409);
    } else if (input.name) {
      await InvoiceTemplate.updateOne({ _id: id, ownerId }, { $set: { name: input.name } });
    }
    return (await this.list(ownerId)).find((x) => x.id === id)!;
  }
  async duplicate(ownerId: string, id: string): Promise<TemplateSummary> {
    const t = await this.get(ownerId, id);
    if (!t) throw new TemplateError("Template not found", 404);
    const v = t.version as Partial<VersionRecord> & { source: string };
    return this.create(ownerId, { name: `${t.name} (copy)`.slice(0, 80), type: t.builtin ? "html" : (t.type as TemplateType), source: v.source, builder: v.builder, originalAssetId: v.originalAssetId });
  }
  async remove(ownerId: string, id: string): Promise<void> {
    if (isBuiltin(id)) throw new TemplateError("Built-in templates cannot be deleted.", 409);
    if (!isId(id)) throw new TemplateError("Template not found", 404);
    const r = await InvoiceTemplate.deleteOne({ _id: id, ownerId });
    if (r.deletedCount === 0) throw new TemplateError("Template not found", 404);
    // Versions are kept on purpose: invoices already made with this template still regenerate exactly.
    await BusinessProfile.updateOne({ ownerId, defaultTemplateId: id }, { $set: { defaultTemplateId: "builtin:technolites" } });
  }
  /** One default per user: it is a single field on the user's (unique) business profile. */
  async setDefault(ownerId: string, id: string): Promise<void> {
    if (!isBuiltin(id)) {
      if (!isId(id) || !(await InvoiceTemplate.exists({ _id: id, ownerId }))) throw new TemplateError("Template not found", 404);
    }
    await BusinessProfile.updateOne({ ownerId }, { $set: { defaultTemplateId: id, defaultChosen: true }, $setOnInsert: { ownerId } }, { upsert: true });
  }
  async versions(ownerId: string, id: string): Promise<VersionRecord[]> {
    if (!isId(id) || !(await InvoiceTemplate.exists({ _id: id, ownerId }))) throw new TemplateError("Template not found", 404);
    return (await InvoiceTemplateVersion.find({ templateId: id, ownerId }).sort({ version: -1 }).limit(100).lean()).map(toVersion);
  }
  /** Roll back = copy an old version forward as the newest version (history is never rewritten). */
  async rollback(ownerId: string, id: string, version: number): Promise<TemplateSummary> {
    if (!isId(id)) throw new TemplateError("Template not found", 404);
    const old = await InvoiceTemplateVersion.findOne({ templateId: id, ownerId, version }).lean<any>();
    if (!old) throw new TemplateError("That version does not exist", 404);
    return this.update(ownerId, id, { source: old.source, builder: old.builder ?? undefined, originalAssetId: old.originalAssetId });
  }

  // ---------- which template an invoice uses ----------
  /** The version id a NEW invoice records: the chosen template (if it is the user's) or the user's default. */
  async resolveVersionId(ownerId: string | undefined, templateId?: string): Promise<string> {
    if (!ownerId) return builtinVersionId("builtin:technolites");
    const want = templateId || (await this.getBusiness(ownerId)).defaultTemplateId;
    if (isBuiltin(want)) return builtinVersionId(want);
    if (isId(want)) {
      const t = await InvoiceTemplate.findOne({ _id: want, ownerId }).lean<any>();
      if (t) return t.currentVersionId;
    }
    return builtinVersionId("builtin:technolites");
  }
  /** Source and options for a recorded version. ownerId is checked so a version id can never cross users. */
  async renderable(versionId: string, ownerId?: string): Promise<Renderable> {
    const builtin = parseBuiltinVersionId(versionId);
    if (builtin) return { source: builtinSource(builtin), versionId, name: BUILTINS.find((b) => b.id === builtin)!.name };
    if (!isId(versionId)) throw new Error(`Unknown template version ${versionId}`);
    const v = await InvoiceTemplateVersion.findOne({ _id: versionId, ...(ownerId ? { ownerId } : {}) }).lean<any>();
    if (!v) throw new Error(`Template version ${versionId} not found`);
    const t = await InvoiceTemplate.findById(v.templateId).select("name").lean<any>();
    const name = t?.name ?? "Deleted template";
    if (v.builder) return { source: builderSource(v.builder), brand: builderBrand(v.builder), overrides: v.builder.overrides, versionId, name };
    return { source: v.source, versionId, name };
  }

  // ---------- assets ----------
  async saveAsset(ownerId: string, name: string, data: Buffer): Promise<{ id: string; name: string; mime: string; size: number }> {
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const ext = path.extname(safe).toLowerCase();
    const mime = ASSET_TYPES[ext];
    if (!mime) throw new TemplateError(`File type ${ext || "(none)"} is not allowed. Allowed: ${Object.keys(ASSET_TYPES).join(", ")}`, 415);
    if (data.length === 0) throw new TemplateError("The file is empty");
    if (data.length > MAX_ASSET_BYTES) throw new TemplateError("Files can be at most 5 MB", 413);
    checkMagic(ext, data);
    if ((await TemplateAsset.countDocuments({ ownerId })) >= MAX_ASSETS_PER_USER && !(await TemplateAsset.exists({ ownerId, name: safe }))) throw new TemplateError("You have 50 files already. Delete some first.", 409);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const ownerDir = path.join(path.resolve(this.assetDir), createHash("sha256").update(ownerId).digest("hex").slice(0, 32));
    fs.mkdirSync(ownerDir, { recursive: true });
    const file = path.join(ownerDir, `${sha256}${ext}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, data);
    const d = await TemplateAsset.findOneAndUpdate({ ownerId, name: safe }, { $set: { mime, size: data.length, sha256, path: file } }, { upsert: true, new: true, lean: true }) as any;
    return { id: String(d._id), name: safe, mime, size: data.length };
  }
  async listAssets(ownerId: string) {
    return (await TemplateAsset.find({ ownerId }).sort({ name: 1 }).lean<any[]>()).map((a) => ({ id: String(a._id), name: a.name, mime: a.mime, size: a.size }));
  }
  async deleteAsset(ownerId: string, id: string) {
    if (!isId(id) || (await TemplateAsset.deleteOne({ _id: id, ownerId })).deletedCount === 0) throw new TemplateError("File not found", 404);
  }
  async readAsset(ownerId: string, id: string): Promise<{ name: string; mime: string; data: Buffer } | null> {
    if (!id || !isId(id)) return null;
    const a = await TemplateAsset.findOne({ _id: id, ownerId }).lean<any>();
    if (!a) return null;
    const root = path.resolve(this.assetDir) + path.sep;
    if (!path.resolve(a.path).startsWith(root) || !fs.existsSync(a.path)) return null;
    return { name: a.name, mime: a.mime, data: fs.readFileSync(a.path) };
  }
  /** name -> data: URI for every image/font the user uploaded (what asset:NAME in a template becomes). */
  async assetDataUris(ownerId: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let total = 0;
    for (const a of await TemplateAsset.find({ ownerId, mime: { $in: ["image/png", "image/jpeg", "image/svg+xml", "font/woff2"] } }).lean<any[]>()) {
      if (total + a.size > 20 * 1024 * 1024) break;
      const f = await this.readAsset(ownerId, String(a._id));
      if (f) { out[a.name] = `data:${a.mime};base64,${f.data.toString("base64")}`; total += a.size; }
    }
    return out;
  }
  async assetNames(ownerId: string): Promise<string[]> { return (await TemplateAsset.find({ ownerId }).select("name").lean<any[]>()).map((a) => a.name); }
  async dataUriFor(ownerId: string, assetId: string): Promise<string> {
    const f = await this.readAsset(ownerId, assetId);
    return f && f.mime.startsWith("image/") ? `data:${f.mime};base64,${f.data.toString("base64")}` : "";
  }
}

/** The file must really be what its extension says (stops renamed executables and HTML-in-a-PNG). */
function checkMagic(ext: string, data: Buffer) {
  const head = data.subarray(0, 8);
  const ok =
    ext === ".png" ? head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) :
    ext === ".jpg" || ext === ".jpeg" ? head[0] === 0xff && head[1] === 0xd8 :
    ext === ".woff2" ? head.subarray(0, 4).toString("latin1") === "wOF2" :
    ext === ".docx" ? head[0] === 0x50 && head[1] === 0x4b :
    ext === ".svg" ? /<svg[\s>]/i.test(data.subarray(0, 2048).toString("utf8")) && !/<script|\son\w+\s*=|javascript:|<foreignObject/i.test(data.toString("utf8")) :
    true;
  if (!ok) throw new TemplateError(ext === ".svg" ? "That SVG contains scripts or is not an SVG image" : `That file is not a real ${ext} file`, 415);
}
