import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderTemplateHtml, validateTemplate } from "../../src/invoiceTemplates/engine";
import { PLACEHOLDERS } from "../../src/invoiceTemplates/placeholders";
import { sanitizeTemplateHtml } from "../../src/invoiceTemplates/sanitize";
import { buildViewData, sampleSnapshot } from "../../src/invoiceTemplates/viewModel";

const MIN = "<p>{{invoice.number}} {{client.name}} {{totals.total}}</p>";
const data = () => buildViewData(sampleSnapshot(), { number: "INV-1" });
const errors = (src: string, names: string[] = []) => validateTemplate(src, { assetNames: names }).issues.filter((i) => i.level === "error").map((i) => i.message);

describe("placeholder validation", () => {
  it("accepts a template with the required fields", () => { expect(validateTemplate(MIN).ok).toBe(true); });
  it("lists every missing required field", () => {
    const e = errors("<p>{{business.name}}</p>");
    expect(e).toEqual(expect.arrayContaining([expect.stringContaining("invoice.number"), expect.stringContaining("client.name"), expect.stringContaining("totals.total")]));
  });
  it("flags unknown placeholders, with a hint inside the items loop", () => {
    expect(errors(MIN + "{{client.nmae}}")).toEqual([expect.stringContaining("{{client.nmae}}")]);
    expect(errors(MIN + "{{#each items}}{{price}}{{/each}}")[0]).toMatch(/Inside \{\{#each items\}\}/);
  });
  it("item fields only work inside the loop; outer fields need ../ inside it", () => {
    expect(errors(MIN + "{{description}}")).toHaveLength(1);
    expect(errors(MIN + "{{#each items}}{{description}} {{../client.name}} {{@index}}{{/each}}")).toEqual([]);
    expect(errors(MIN + "{{#each totals}}x{{/each}}").join(" ")).toMatch(/Only \{\{#each items\}\}/);
  });
  it("refuses raw output, partials, decorators and custom helpers", () => {
    for (const bad of ["{{{client.name}}}", "{{& client.name}}", "{{> header}}", "{{#lookup x}}{{/lookup}}", "{{log client.name}}", "{{#* inline \"x\"}}y{{/inline}}"]) {
      expect(validateTemplate(MIN + bad).ok, bad).toBe(false);
    }
  });
  it("reports syntax errors instead of crashing", () => {
    expect(errors(MIN + "{{#if invoice.notes}}unclosed")[0]).toMatch(/syntax error/i);
  });
  it("checks images: placeholders and uploaded assets are fine, external links are flagged", () => {
    expect(errors(MIN + '<img src="{{business.logo}}"><img src="asset:sig.png"><img src="data:image/png;base64,AAAA">', ["sig.png"])).toEqual([]);
    expect(errors(MIN + '<img src="asset:missing.png">')[0]).toMatch(/not uploaded/);
    expect(errors(MIN + '<img src="https://evil.test/track.gif">')[0]).toMatch(/cannot load/);
  });
  it("warns that scripts will be removed", () => {
    expect(validateTemplate(MIN + "<script>x()</script>").issues.some((i) => i.level === "warning")).toBe(true);
  });
  it("every built-in template and the example are valid; the example uses every placeholder", () => {
    const dir = path.resolve(__dirname, "../../templates/invoice");
    for (const f of fs.readdirSync(dir)) expect(validateTemplate(fs.readFileSync(path.join(dir, f), "utf8")).ok, f).toBe(true);
    const v = validateTemplate(fs.readFileSync(path.join(dir, "example-all-placeholders.hbs"), "utf8"));
    expect(PLACEHOLDERS.flatMap((g) => g.fields.map((f) => f.path)).filter((p) => !v.fields.includes(p))).toEqual([]);
  });
});

describe("sanitiser: malicious markup is stripped", () => {
  const evil = [
    "<script>alert(1)</script>", '<img src=x onerror="alert(1)">', '<a href="javascript:alert(1)">x</a>', '<iframe src="https://evil.test"></iframe>',
    '<object data="x.swf"></object>', '<embed src="x">', '<svg><script>alert(1)</script></svg>', '<form action="https://evil.test"><input></form>',
    '<link rel="stylesheet" href="https://evil.test/x.css">', '<meta http-equiv="refresh" content="0;url=https://evil.test">',
    '<div style="background:url(https://evil.test/track.gif)">x</div>', "<style>@import url(https://evil.test/a.css); body{background:url('https://evil.test/b.png')}</style>",
    '<p onclick="steal()" onmouseover="x">hi</p>', '<img src="https://evil.test/pixel.gif">', '<a href="  JaVaScRiPt:alert(1)">x</a>', '<base href="https://evil.test/">',
    '<IMG SRC="jav&#x09;ascript:alert(1)">', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  ];
  it.each(evil)("%s", (html) => {
    const out = sanitizeTemplateHtml(MIN + html).toLowerCase();
    expect(out).not.toMatch(/<script|onerror|onclick|onmouseover|javascript:|<iframe|<object|<embed|<svg|<form|<link|http-equiv|evil\.test|<base|<math/);
  });
  it("keeps placeholders, loops, tables and styling intact", () => {
    const src = '<style>.a{color:red}</style><table><tbody>{{#each items}}<tr><td class="a" style="color:blue">{{description}}</td></tr>{{/each}}</tbody></table><img src="{{business.logo}}"><img src="asset:logo.png">' + MIN;
    const out = sanitizeTemplateHtml(src);
    for (const keep of ["{{#each items}}", "{{/each}}", "{{description}}", 'src="{{business.logo}}"', 'src="asset:logo.png"', ".a{color:red}", 'style="color:blue"']) expect(out).toContain(keep);
  });
  it("output always starts with a doctype (no quirks-mode layout)", () => { expect(sanitizeTemplateHtml("<p>x</p>")).toMatch(/^<!doctype html>/); });
});

describe("rendering", () => {
  it("fills in data and escapes it: a client named <script> stays text", () => {
    const d: any = data(); d.client.name = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const html = renderTemplateHtml(MIN, d);
    expect(html).not.toMatch(/<script|<img src="?x/i);
    expect(html).toContain("&lt;script&gt;");
  });
  it("cannot reach prototypes or constructors", () => {
    const html = renderTemplateHtml(MIN + "{{constructor.name}}{{__proto__.polluted}}{{client.constructor}}{{toString}}", data());
    expect(html).not.toMatch(/Object|function|\[native code\]/);
  });
  it("asset:NAME becomes the user's data: URI; unknown assets stay inert", () => {
    const html = renderTemplateHtml(MIN + '<img src="asset:logo.png"><img src="asset:other.png">', data(), { "logo.png": "data:image/png;base64,QUJD" });
    expect(html).toContain('src="data:image/png;base64,QUJD"');
    expect(html).not.toContain("other.png\"><");
  });
  it("loops over items with ../ access to outer fields", () => {
    const html = renderTemplateHtml(MIN + "{{#each items}}[{{no}}:{{description}}:{{../invoice.number}}]{{/each}}", data());
    expect(html).toContain("[1:Website design and development (5 pages):INV/2026/0042]");
    expect(html.match(/\[\d:/g)).toHaveLength(3);
  });
});
