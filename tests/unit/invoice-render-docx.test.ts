import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";
import { docxToTemplateHtml } from "../../src/invoiceTemplates/docx";
import { renderTemplateHtml, validateTemplate } from "../../src/invoiceTemplates/engine";
import { closeRenderer, htmlToPdf, type RenderStats } from "../../src/invoiceTemplates/renderer";
import { buildViewData, sampleSnapshot } from "../../src/invoiceTemplates/viewModel";

let chromiumOk = true;
try { require("playwright-core").chromium.executablePath(); require("node:fs").accessSync(require("playwright-core").chromium.executablePath()); } catch { chromiumOk = false; }
let pdftotext = true;
try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); } catch { pdftotext = false; }
const textOf = (pdf: Buffer) => execFileSync("pdftotext", ["-", "-"], { input: pdf }).toString();

afterAll(async () => { await closeRenderer(); });

describe.skipIf(!chromiumOk)("Chromium renderer is locked down (defence in depth, even for unsanitised HTML)", () => {
  it("produces a real A4 PDF", async () => {
    const pdf = await htmlToPdf("<!doctype html><p>Hello invoice</p>");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    if (pdftotext) expect(textOf(pdf)).toContain("Hello invoice");
  });
  it.skipIf(!pdftotext)("JavaScript does not run: scripts and onerror handlers cannot change the page", async () => {
    const pdf = await htmlToPdf('<!doctype html><p id="t">ORIGINAL</p><script>document.getElementById("t").textContent="HACKED"</script><img src="x:" onerror="document.body.innerHTML=\'HACKED2\'">');
    const t = textOf(pdf);
    expect(t).toContain("ORIGINAL");
    expect(t).not.toMatch(/HACKED/);
  });
  it("no network: images, CSS and fonts from servers are never fetched", async () => {
    let hits = 0;
    const srv = http.createServer((_q, r) => { hits++; r.end("x"); });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const u = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const stats: RenderStats = { blockedRequests: [] };
    await htmlToPdf(`<!doctype html><link rel="stylesheet" href="${u}/a.css"><style>@font-face{font-family:x;src:url(${u}/f.woff2)} body{font-family:x;background:url(${u}/bg.png)}</style><img src="${u}/pixel.gif"><iframe src="${u}/frame"></iframe><p>x</p>`, { stats });
    srv.close();
    expect(hits).toBe(0);
    expect(stats.blockedRequests.length).toBeGreaterThan(0);
  });
  it("has a time limit", async () => {
    await expect(htmlToPdf("<p>x</p>", { timeoutMs: 1 })).rejects.toThrow();
  });
  it("renders a built-in template with sample data to a PDF that shows the totals", async () => {
    const src = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../../templates/invoice/gst.hbs"), "utf8");
    const pdf = await htmlToPdf(renderTemplateHtml(src, buildViewData(sampleSnapshot(), { number: "X" })));
    if (pdftotext) {
      const t = textOf(pdf);
      expect(t).toContain("TAX INVOICE");
      expect(t).toContain("93,220.00");
      expect(t).toContain("Ninety Three Thousand Two Hundred Twenty Rupees Only");
    }
  });
});

async function makeDocx(paragraphs: string[], extra: Record<string, string> = {}, contentTypeExtra = ""): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml${contentTypeExtra}"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const body = paragraphs.map((p) => `<w:p>${p}</w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  for (const [k, v] of Object.entries(extra)) zip.file(k, v);
  return zip.generateAsync({ type: "nodebuffer" });
}
const run = (t: string, bold = false) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;

describe("DOCX templates", () => {
  it("converts Word text with placeholders, joins placeholders split by formatting, and expands [[ITEMS_TABLE]]", async () => {
    const buf = await makeDocx([run("Invoice "), run("{{invoice.number}}"), run("Client: {{client."), `${run("name", true)}${run("}}")}`, run("[[ITEMS_TABLE]]"), run("Total {{totals.total}}")]);
    const { html } = await docxToTemplateHtml(buf);
    expect(html).toContain("{{invoice.number}}");
    expect(html).toContain("{{client.name}}");
    expect(html).toContain("{{#each items}}");
    expect(validateTemplate(html).ok).toBe(true);
    const out = renderTemplateHtml(html, buildViewData(sampleSnapshot(), { number: "X" }));
    expect(out).toContain("Greenleaf Organics");
    expect(out).toContain("Shopify store setup");
  });
  it("refuses macro-enabled files", async () => {
    await expect(docxToTemplateHtml(await makeDocx([run("x")], { "word/vbaProject.bin": "MACRO" }))).rejects.toThrow(/Macro/);
    await expect(docxToTemplateHtml(await makeDocx([run("x")], {}, ".macroEnabled"))).rejects.toThrow(/Macro/);
  });
  it("refuses files that are not Word documents, or that carry programs", async () => {
    await expect(docxToTemplateHtml(Buffer.from("not a zip"))).rejects.toThrow(/not a valid/);
    const z = new JSZip(); z.file("a.txt", "x");
    await expect(docxToTemplateHtml(await z.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/no document/);
    await expect(docxToTemplateHtml(await makeDocx([run("x")], { "word/embeddings/run.exe": "MZ" }))).rejects.toThrow(/program/);
  });
});
