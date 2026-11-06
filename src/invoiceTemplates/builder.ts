import { z } from "zod";
import { builtinSource } from "./builtins";
import type { BrandOptions } from "./viewModel";

/** Quick builder (no code): a base layout plus options. Stored as JSON in the template version. */
export const FONTS = {
  system: "Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  modern: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "'Courier New', monospace",
} as const;

export const builderSchema = z.object({
  layout: z.enum(["builtin:standard", "builtin:minimal", "builtin:corporate", "builtin:gst", "builtin:technolites"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colour must look like #4f46e5"),
  font: z.enum(["system", "serif", "modern", "mono"]),
  showLogo: z.boolean().default(true),
  columns: z.object({ qty: z.boolean(), rate: z.boolean(), tax: z.boolean() }),
  footer: z.string().max(300).default(""),
  terms: z.string().max(1000).default(""),
  /** Optional overrides of the business profile, used only by this template. Empty = use the profile. */
  overrides: z.object({
    name: z.string().max(120).optional(), address: z.string().max(500).optional(), gstin: z.string().max(15).optional(),
    email: z.string().max(200).optional(), phone: z.string().max(30).optional(),
    bankName: z.string().max(80).optional(), account: z.string().max(34).optional(), ifsc: z.string().max(11).optional(),
    upiId: z.string().max(60).optional(), paymentLink: z.string().max(300).optional(),
  }).default({}),
}).strict();
export type BuilderOptions = z.infer<typeof builderSchema>;

export function builderBrand(b: BuilderOptions): BrandOptions {
  return { color: b.color, font: FONTS[b.font], cols: b.columns, footer: b.footer, terms: b.terms || undefined };
}
/** The HTML source a builder template renders with: its base layout. Options are applied through the data. */
export function builderSource(b: BuilderOptions): string {
  const src = builtinSource(b.layout);
  return b.showLogo ? src : src.replace(/\{\{#if business\.logo\}\}/g, "{{#if business.no_logo}}");
}
