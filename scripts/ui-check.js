const { chromium } = require("playwright");
/**
 * Browser test of the dashboard against a RUNNING API + worker (real Redis and MongoDB).
 *   API_URL=http://127.0.0.1:3000 API_KEY=<key> node scripts/ui-check.js
 * Needs Playwright (not a project dependency):  npm i --no-save playwright && npx playwright install chromium
 * Use an EMPTY database: it assumes no leads exist yet. Screenshots go to ./ui-shots.
 */
const fs = require("node:fs");
const BASE = process.env.API_URL || "http://127.0.0.1:3000";
const KEY = process.env.API_KEY;
if (!KEY) { console.error("API_KEY is required"); process.exit(2); }
const SHOTS = process.env.SHOTS_DIR || "./ui-shots";
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/401|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });

  await page.goto(BASE);
  await page.waitForSelector("#gate:not([hidden])");
  check("key gate shown first", true);
  await page.screenshot({ path: `${SHOTS}/1-gate.png` });

  await page.fill("#gateKey", "wrongkey_wrongkey_00");
  await page.click("#gateForm button[type=submit]");
  await page.waitForFunction(() => document.getElementById("gateErr").textContent.length > 0);
  check("wrong key is refused with a message", /not accepted/.test(await page.textContent("#gateErr")));

  await page.fill("#gateKey", KEY);
  await page.click("#gateForm button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  await page.waitForFunction(() => document.getElementById("pMongo").className.includes("up") && document.getElementById("pRedis").className.includes("up"));
  check("dashboard opens; MongoDB and Redis pills are green", true);
  check("demo-mode email badge is shown", /demo mode/.test(await page.textContent("#pMail")));
  check("six pipeline columns", (await page.locator(".col").count()) === 6);

  // XSS probe in a lead name
  await page.click("#btnNew");
  await page.fill("#fNew [name=name]", '<img src=x onerror="window.__xss=1">Asha Verma');
  await page.fill("#fNew [name=company]", "Blossom <b>Studios</b>");
  await page.click("#fNew button[type=submit]");
  await page.waitForSelector('.col[data-state="New"] .card');
  check("lead appears in New", (await page.locator('.col[data-state="New"] .card').count()) === 1);
  check("lead name is shown as text, not executed (no XSS)", (await page.evaluate(() => window.__xss)) === undefined && (await page.locator(".card h3 img").count()) === 0);

  const card = () => page.locator(".card").first();
  const moveTo = async (to) => { await page.locator(`.card [data-act=move][data-to="${to}"]`).first().click(); };
  await moveTo("Contacted");
  await page.waitForSelector('.col[data-state="Contacted"] .card');
  check("New -> Contacted via button", true);
  await moveTo("Negotiation");
  await page.waitForSelector('.col[data-state="Negotiation"] .card');
  check("Contacted -> Negotiation via button", true);

  // second lead for drag and drop
  await page.click("#btnNew");
  await page.fill("#fNew [name=name]", "Ravi Kumar");
  await page.fill("#fNew [name=company]", "Kumar & Sons");
  await page.click("#fNew button[type=submit]");
  await page.waitForSelector('.col[data-state="New"] .card');
  await page.locator('.col[data-state="New"] .card').first().dragTo(page.locator('.col[data-state="Contacted"]'));
  await page.waitForSelector('.col[data-state="Contacted"] .card');
  check("drag New -> Contacted works", true);
  await page.locator('.col[data-state="Contacted"] .card').first().dragTo(page.locator('.col[data-state="Closed-Won"]'));
  await page.waitForFunction(() => /Cannot move/.test(document.getElementById("toasts").textContent));
  check("illegal drag (Contacted -> Closed-Won) is refused with a clear message", (await page.locator('.col[data-state="Closed-Won"] .card').count()) === 0);

  // Close the deal
  await page.locator(`.col[data-state="Negotiation"] [data-act=move][data-to="Closed-Won"]`).click();
  await page.waitForSelector("#fDeal");
  await page.screenshot({ path: `${SHOTS}/2-deal-modal.png` });
  await page.fill("#fDeal [name=email]", "client@example.com");
  await page.fill("#fDeal [name=amount]", "4999.50");
  await page.click("#fDeal button[type=submit]");
  await page.waitForSelector('.col[data-state="Closed-Won"] .card');
  check("Closed-Won card appears", true);
  await page.waitForFunction(() => /Email sent/.test(document.getElementById("invBody").textContent), null, { timeout: 25000 });
  check("invoice row reaches 'Email sent' via outbox -> queue -> worker", true);
  check("won card shows 'Client created' chip", /Client created/.test(await page.textContent('.col[data-state="Closed-Won"]')));
  check("amount formatted as rupees", /₹\s?4,999\.50/.test(await page.textContent("#invBody")));
  await page.screenshot({ path: `${SHOTS}/3-board-desktop.png`, fullPage: true });

  // PDF through the UI
  const [popup] = await Promise.all([ctx.waitForEvent("page"), page.click('[data-act=pdf]')]);
  await page.waitForTimeout(1500);
  check("'Open PDF' opens a new tab without an error toast", popup && !/not available/.test(await page.textContent("#toasts")));
  const pdfHead = await page.evaluate(async (k) => {
    const inv = await (await fetch("/api/invoices?limit=1", { headers: { Authorization: "Bearer " + k } })).json();
    const r = await fetch("/api/invoices/" + inv.data[0].id + "/pdf", { headers: { Authorization: "Bearer " + k } });
    return { type: r.headers.get("content-type"), head: (await r.text()).slice(0, 5) };
  }, KEY);
  check("PDF endpoint returns a real PDF", pdfHead.type === "application/pdf" && pdfHead.head === "%PDF-", JSON.stringify(pdfHead));
  await popup.close();

  // Detail modal + history
  await page.click('[data-act=detail] >> nth=0');
  await page.waitForSelector(".hist");
  check("lead detail shows history and invoice", /History/.test(await page.textContent(".modal")));
  await page.screenshot({ path: `${SHOTS}/4-detail.png` });
  await page.keyboard.press("Escape");

  // Reopen needs a reason
  await page.locator(`.col[data-state="Closed-Won"] [data-act=move][data-to="Negotiation"]`).click();
  await page.waitForSelector("#fReason");
  await page.fill("#fReason [name=reason]", "Client asked to renegotiate");
  await page.click("#fReason button[type=submit]");
  await page.waitForFunction(() => document.querySelectorAll('.col[data-state="Negotiation"] .card').length === 1);
  check("reopening Closed-Won asks for a reason and moves back to Negotiation", true);

  // search
  await page.fill("#search", "ravi");
  check("search filters the board", (await page.locator(".card").count()) === 1);
  await page.fill("#search", "");

  // stale tab: change from another client, then click in this stale view
  const stale = await page.evaluate(async (k) => {
    const l = await (await fetch("/api/leads?limit=100", { headers: { Authorization: "Bearer " + k } })).json();
    const lead = l.data.find((x) => x.currentState === "Contacted");
    const r = await fetch("/api/leads/" + lead.id + "/transition", { method: "POST", headers: { Authorization: "Bearer " + k, "Content-Type": "application/json" }, body: JSON.stringify({ targetState: "Follow-up", version: lead.version }) });
    return r.status;
  }, KEY);
  check("(setup) another client moved a lead", stale === 200);

  // mobile
  const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await m.newPage();
  await mp.goto(BASE); await mp.waitForSelector("#gate:not([hidden])");
  await mp.fill("#gateKey", KEY); await mp.click("#gateForm button[type=submit]");
  await mp.waitForSelector("#app:not([hidden])"); await mp.waitForSelector(".card");
  const overflowX = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  check("mobile: page itself does not scroll sideways (board scrolls inside itself)", !overflowX);
  await mp.screenshot({ path: `${SHOTS}/5-mobile.png` });

  // ---- website scraper ----
  await page.waitForSelector("#scrapePanel:not([hidden])");
  check("scraper panel and demo-page shortcuts are visible", await page.isVisible("#demos"));
  const before = await page.locator(".card").count();
  await page.click('[data-demo="bakery"]');
  await page.waitForFunction(() => /Done/.test(document.getElementById("jobs").textContent), null, { timeout: 30000 });
  check("demo page scraped by the worker: job shows Done with the emails found", /orders@bloombakery\.test/.test(await page.textContent("#jobs")) && /press@bloombakery\.test/.test(await page.textContent("#jobs")) && /\+919876543210/.test(await page.textContent("#jobs")));
  await page.waitForFunction((n) => document.querySelectorAll(".card").length === n + 1, before);
  const scraped = page.locator('.col[data-state="New"] .card', { hasText: "Bloom Bakery" });
  check("scraped lead appears in New with the Scraped chip, website and email", (await scraped.count()) === 1 && /Scraped/.test(await scraped.textContent()) && /orders@bloombakery\.test/.test(await scraped.textContent()) && /\+919876543210/.test(await scraped.textContent()));
  await page.screenshot({ path: `${SHOTS}/6-scraper.png`, fullPage: true });

  await page.click('[data-demo="bakery"]');
  await page.waitForFunction(() => /Already in your pipeline/.test(document.getElementById("toasts").textContent), null, { timeout: 30000 });
  check("scraping the same page again does not create a duplicate lead", (await page.locator(".card").count()) === before + 1);

  await page.click('[data-demo="dental"]');
  await page.waitForFunction(() => /2 pages read/.test(document.getElementById("jobs").textContent), null, { timeout: 30000 });
  check("contact details on the Contact page are found too (2 pages read: email + phone)", /info@brightsmile\.test/.test(await page.textContent("#jobs")) && /\+912212345678/.test(await page.textContent("#jobs")));
  await page.click('[data-demo="private"]');
  await page.waitForFunction(() => /robots\.txt/.test(document.getElementById("jobs").textContent), null, { timeout: 30000 });
  check("a page blocked by robots.txt is refused with a clear reason", /Failed/.test(await page.textContent("#jobs")));

  await page.fill("#scrapeUrl", BASE + "/api/leads");
  await page.click("#btnScrape");
  await page.waitForFunction(() => document.getElementById("scrapeErr").textContent.length > 0);
  check("an internal address is refused before anything is queued", /cannot be scraped/.test(await page.textContent("#scrapeErr")));

  await scraped.locator("[data-act=move][data-to=Contacted]").click();
  await page.waitForSelector('.col[data-state="Contacted"] .card:has-text("Bloom Bakery")');
  await page.locator('.col[data-state="Contacted"] .card:has-text("Bloom Bakery") [data-act=move][data-to="Follow-up"]').click();
  await page.waitForSelector('.col[data-state="Follow-up"] .card:has-text("Bloom Bakery")');
  await page.locator('.col[data-state="Follow-up"] .card:has-text("Bloom Bakery") [data-act=move][data-to="Negotiation"]').click();
  await page.waitForSelector('.col[data-state="Negotiation"] .card:has-text("Bloom Bakery")');
  await page.locator('.col[data-state="Negotiation"] .card:has-text("Bloom Bakery") [data-act=move][data-to="Closed-Won"]').click();
  await page.waitForSelector("#fDeal");
  check("closing a scraped lead pre-fills the client email found by the scraper", (await page.inputValue("#fDeal [name=email]")) === "orders@bloombakery.test");
  await page.click("#fDeal button[type=submit]");
  await page.waitForSelector('#invBody tr:has-text("orders@bloombakery.test"):has-text("Email sent")', { timeout: 25000 });
  check("full chain: scraped lead -> Closed-Won -> invoice + PDF -> email sent to the scraped address", true);
  await page.screenshot({ path: `${SHOTS}/7-scraped-to-invoice.png`, fullPage: true });

  // ---- Lead Finder (needs LEAD_FINDER_MOCK=true on the server) ----
  await page.waitForSelector("#tabs:not([hidden])");
  check("Lead Finder tab exists and the badge is hidden", (await page.locator("#finderBadge").isHidden()));
  await page.click('[data-tab="finder"]');
  await page.waitForSelector("#viewFinder:not([hidden])");
  await page.waitForSelector("#fMock:not([hidden])", { timeout: 10000 }).catch(() => undefined);
  check("demo-mode banner is shown", await page.isVisible("#fMock"));
  await page.click("#fGo");
  await page.waitForFunction(() => /Describe your business/.test(document.getElementById("fErr").textContent));
  check("auto search without a profile is refused with a clear message", true);

  await page.fill("#fpText", "We build websites for small businesses: React, WordPress, Shopify");
  await page.click("#fpSuggest");
  await page.waitForSelector("#fpKws .kw");
  const kwCount = await page.locator("#fpKws .kw").count();
  check("keywords are suggested from the description", kwCount >= 6 && /website/.test(await page.textContent("#fpKws")));
  await page.locator("#fpKws .kw button").last().click();
  await page.fill("#fpAdd", "figma"); await page.press("#fpAdd", "Enter");
  check("keywords can be removed and added", (await page.locator("#fpKws .kw").count()) === kwCount && /figma/.test(await page.textContent("#fpKws")));
  await page.click("#fpSave");
  await page.waitForFunction(() => /profile saved/i.test(document.getElementById("toasts").textContent));
  check("service profile saves", true);

  await page.click("#fGo");
  await page.waitForFunction(() => /Sample data/.test(document.getElementById("fSrcs").textContent) && /done/.test(document.getElementById("fSrcs").textContent), null, { timeout: 30000 });
  await page.waitForSelector("#frBody tr .score");
  const scores = await page.$$eval("#frBody .score", (els) => els.map((e) => Number(e.textContent)));
  check("auto search shows scored results, best match first", scores.length >= 5 && scores.every((v, i) => i === 0 || scores[i - 1] >= v), scores.join(","));
  await page.screenshot({ path: `${SHOTS}/8-lead-finder.png`, fullPage: true });

  await page.click("#fmManual");
  await page.fill("#fQuery", "logo");
  await page.click("#fGo");
  await page.waitForFunction(() => /logo/i.test(document.getElementById("frBody").textContent) && !/Searching/.test(document.getElementById("frBody").textContent), null, { timeout: 30000 });
  check("manual search for 'logo' finds the logo request", /Logo and brand identity/.test(await page.textContent("#frBody")));
  const n1 = await page.locator("#frBody tr .score").count();
  await page.selectOption("#frScore", "80");
  await page.waitForFunction((n) => document.querySelectorAll("#frBody tr .score").length < n || /No matching/.test(document.getElementById("frBody").textContent), n1);
  check("minimum-score filter narrows the results", true);
  await page.selectOption("#frScore", "0");

  await page.click("#fmAuto");
  await page.click("#fGo");
  await page.waitForSelector('#frBody [data-act="fdetail"]');
  await page.locator('#frBody [data-act="fdetail"]').first().click();
  await page.waitForSelector(".drawer");
  check("detail drawer shows the post link and how to contact", /Through the original post/.test(await page.textContent(".drawer")) && (await page.locator('.drawer a[target=_blank]').count()) >= 1);
  const title = (await page.textContent(".modal header h2")).trim();
  await page.click('.modal [data-act="fpipe"]');
  await page.waitForFunction(() => /Added to your pipeline/.test(document.getElementById("toasts").textContent));
  await page.click('[data-tab="pipeline"]');
  await page.waitForSelector('.col[data-state="New"] .card:has-text("From Lead Finder")');
  check("Add to pipeline creates a New lead marked 'From Lead Finder' with the post link", (await page.locator('.col[data-state="New"] .card', { hasText: title.slice(0, 25) }).count()) >= 1);
  await page.click('[data-tab="finder"]');
  await page.waitForSelector("#frBody .chip.ok");
  check("the result now shows 'In pipeline'", /In pipeline/.test(await page.textContent("#frBody")));

  await page.locator('#frBody [data-act="fdetail"]').nth(1).click();
  const dismissed = (await page.textContent(".modal header h2")).trim();
  await page.click('.modal [data-act="fdismiss"]');
  await page.waitForFunction((t) => !document.getElementById("frBody").textContent.includes(t), dismissed);
  check("Dismiss removes a request from the list", true);

  await page.click("#fFilters summary");
  await page.check("#fSave"); await page.fill("#fName", "Web client hunt"); await page.selectOption("#fEvery", "6");
  await page.click("#fGo");
  await page.waitForSelector('#fSaved .nm:has-text("Web client hunt")');
  check("a saved search appears in the Saved searches list", true);
  await page.waitForFunction(() => /results/.test(document.getElementById("fSaved").textContent));
  await page.locator('#fSaved [data-act="srun"]').first().click();
  await page.waitForFunction(() => /Search started/.test(document.getElementById("toasts").textContent));
  check("Run now re-runs a saved search", true);
  await page.screenshot({ path: `${SHOTS}/9-lead-finder-saved.png`, fullPage: true });
  await page.locator('#fSaved [data-act="sdel"]').first().click();
  await page.waitForFunction(() => !/Web client hunt/.test(document.getElementById("fSaved").textContent));
  check("a saved search can be removed", true);

  const fm = await ctx.newPage(); await fm.setViewportSize({ width: 390, height: 844 });
  await fm.goto(BASE); await fm.waitForSelector("#app:not([hidden])"); await fm.click('[data-tab="finder"]'); await fm.waitForSelector("#viewFinder:not([hidden])");
  check("mobile: Lead Finder does not scroll the page sideways", !(await fm.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)));
  await fm.screenshot({ path: `${SHOTS}/10-lead-finder-mobile.png` });
  await fm.close();

  // ---- Invoice Templates ----
  const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082", "hex");
  await page.click('[data-tab="templates"]');
  await page.waitForSelector("#viewTemplates:not([hidden]) .tcard");
  check("Invoice Templates tab lists the 4 built-ins with Standard as default", (await page.locator(".tcard").count()) === 4 && /ApexOutbox Standard/.test(await page.textContent(".tcard.def")));
  await page.waitForFunction(() => document.querySelector('[data-thumb="builtin:standard"]').srcdoc.length > 100);
  check("library cards show a rendered thumbnail", true);

  const biz = page.locator("#fBiz");
  check("business details open by default while empty", await page.locator("#bizCard").evaluate((d) => d.open));
  await biz.locator("[name=name]").fill("Apex Web Studio");
  await biz.locator("[name=gstin]").fill("27abcde1234f1z5");
  await biz.locator("[name=state]").selectOption("Maharashtra");
  await biz.locator("[name=defaultGstRate]").selectOption("18");
  await biz.locator("[name=upiId]").fill("apex@hdfc");
  await biz.locator("[name=gstin]").press("Enter");
  await page.waitForFunction(() => /Business details saved/.test(document.getElementById("toasts").textContent));
  await biz.locator("[name=ifsc]").fill("12"); await page.click("#fBiz button[type=submit]");
  await page.waitForFunction(() => /IFSC/.test(document.getElementById("bizErr").textContent));
  check("business details save, and a bad IFSC is refused inline", true);
  await biz.locator("[name=ifsc]").fill("");
  await page.setInputFiles("#bizLogoFile", { name: "logo.png", mimeType: "image/png", buffer: PNG });
  await page.waitForSelector("#bizLogo:not([hidden])");
  check("logo upload shows the logo", true);

  const evilTpl = `<!doctype html><html><body><img src="{{business.logo}}" onerror="alert(1)"><h1>MY UI TEMPLATE</h1><p>{{invoice.number}} {{client.name}} {{business.name}}</p>
<table>{{#each items}}<tr><td>{{description}}</td><td>{{amount}}</td></tr>{{/each}}</table><p>Total {{totals.total}}</p><script>document.body.innerHTML="HACKED"</script></body></html>`;
  await page.setInputFiles("#tFile", { name: "my-template.html", mimeType: "text/html", buffer: Buffer.from(evilTpl) });
  await page.waitForSelector("#editor");
  await page.waitForFunction(() => { const f = document.getElementById("eFrame"); return f && /MY UI TEMPLATE/.test(f.srcdoc); }, null, { timeout: 15000 });
  const src1 = await page.inputValue("#eSrc");
  check("uploaded HTML opens in the editor, sanitised (no script, no onerror)", !/<script|onerror/i.test(src1) && /{{#each items}}/.test(src1));
  const frameHtml = await page.$eval("#eFrame", (f) => f.srcdoc);
  check("live preview shows the user's business name and the logo as an embedded image", /Apex Web Studio/.test(frameHtml) && /data:image\/png;base64/.test(frameHtml) && !/HACKED/.test(frameHtml));
  check("preview frame is sandboxed (no scripts can run in it)", (await page.getAttribute("#eFrame", "sandbox")) === "");
  await page.click("#eSrc"); await page.keyboard.press("End"); await page.keyboard.type("{{client.nmae}}");
  await page.waitForFunction(() => /Unknown placeholder/.test(document.getElementById("eIssues").textContent), null, { timeout: 10000 });
  check("typing an unknown placeholder shows an inline error", true);
  await page.fill("#eSrc", src1);
  await page.locator('#editor [data-ph="client.gstin"]').click();
  check("clicking a placeholder inserts it", /\{\{client\.gstin\}\}/.test(await page.inputValue("#eSrc")));
  await page.waitForFunction(() => !/Unknown placeholder/.test(document.getElementById("eIssues").textContent), null, { timeout: 10000 });
  const [pdfPop] = await Promise.all([ctx.waitForEvent("page"), page.click("#ePdf")]);
  await page.waitForTimeout(1500);
  check("Open exact PDF opens the rendered PDF", !!pdfPop && !/failed/i.test(await page.textContent("#toasts")));
  await pdfPop.close();
  await page.click("#eSave");
  await page.waitForFunction(() => /Template saved \(version 2\)/.test(document.getElementById("toasts").textContent));
  check("saving an edit creates version 2", !(await page.$("#editor")));
  await page.screenshot({ path: `${SHOTS}/11-templates.png`, fullPage: true });

  const myCard = page.locator(".tcard", { hasText: "my-template" });
  await myCard.locator('[data-act="tdefault"]').click();
  await page.waitForSelector('.tcard.def:has-text("my-template")');
  check("Set as default moves the Default badge (only one default)", (await page.locator(".tcard.def").count()) === 1);
  await myCard.locator('[data-act="tvers"]').click();
  await page.waitForSelector('[data-act="trollback"]');
  check("version history lists both versions", (await page.locator(".modal .saved li").count()) === 2);
  await page.click('[data-act="trollback"]');
  await page.waitForFunction(() => /saved as version 3/.test(document.getElementById("toasts").textContent));
  check("rolling back saves the old version as version 3", true);

  await page.click("#tNewBuilder");
  await page.waitForSelector("#bForm");
  await page.fill("#bForm [name=footer]", "BUILDER FOOTER TEXT");
  await page.selectOption("#bForm [name=layout]", "builtin:corporate");
  await page.uncheck("#bForm [name=qty]");
  await page.waitForFunction(() => /BUILDER FOOTER TEXT/.test(document.getElementById("eFrame").srcdoc), null, { timeout: 10000 });
  check("quick builder updates the live preview (layout, footer, columns)", !/>Qty</.test(await page.$eval("#eFrame", (f) => f.srcdoc)));
  await page.fill("#eName", "Builder one");
  await page.click("#eSave");
  await page.waitForSelector('.tcard:has-text("Builder one")');
  check("builder template is saved to the library", true);

  // close a deal with a typed invoice number and GSTINs, using the new default template
  await page.click('[data-tab="pipeline"]');
  await page.click("#btnNew");
  await page.fill("#fNew [name=name]", "Template Client");
  await page.fill("#fNew [name=company]", "Delhi Traders");
  await page.click("#fNew button[type=submit]");
  const tc = () => page.locator(".card", { hasText: "Template Client" });
  await tc().waitFor();
  for (const to of ["Contacted", "Negotiation"]) { await tc().locator(`[data-act=move][data-to="${to}"]`).click(); await page.waitForSelector(`.col[data-state="${to}"] .card:has-text("Template Client")`); }
  await tc().locator('[data-act=move][data-to="Closed-Won"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#fDeal [name=templateId] option").length > 0);
  check("deal form has invoice number, GSTIN, state, GST rate and template fields, pre-filled from the profile",
    (await page.inputValue("#fDeal [name=businessGstin]")) === "27ABCDE1234F1Z5" && (await page.inputValue("#fDeal [name=gstRate]")) === "18" && /my-template \(default\)/.test(await page.textContent("#fDeal [name=templateId]")));
  await page.fill("#fDeal [name=email]", "accounts@delhitraders.test");
  await page.fill("#fDeal [name=amount]", "50000");
  await page.fill("#fDeal [name=invoiceNumber]", "INV/UI/001");
  await page.fill("#fDeal [name=clientGstin]", "07pqrsx6789k1z2");
  await page.click("#fDeal button[type=submit]");
  await page.waitForSelector('#invBody tr:has-text("INV/UI/001"):has-text("Email sent")', { timeout: 25000 });
  check("the invoice uses the typed number, IGST across states, and is emailed", /IGST 18%/.test(await page.textContent('#invBody tr:has-text("INV/UI/001")')) && /59,000\.00/.test(await page.textContent('#invBody tr:has-text("INV/UI/001")')));
  const pdfText = await page.evaluate(async (k) => {
    const inv = (await (await fetch("/api/invoices?limit=5", { headers: { Authorization: "Bearer " + k } })).json()).data.find((i) => i.invoiceNumber === "INV/UI/001");
    const r = await fetch("/api/invoices/" + inv.id + "/pdf", { headers: { Authorization: "Bearer " + k } });
    const buf = await r.arrayBuffer();
    return { type: r.headers.get("content-type"), size: buf.byteLength, tpl: inv.templateVersionId, status: r.status, body: buf.byteLength < 300 ? new TextDecoder().decode(buf) : "" };
  }, KEY);
  check("its PDF was made with the user's template (version recorded on the invoice)", pdfText.type === "application/pdf" && pdfText.size > 5000 && !!pdfText.tpl && !/^builtin/.test(pdfText.tpl), JSON.stringify(pdfText));
  await page.locator('#invBody tr:has-text("INV/UI/001") [data-act="regen"]').click();
  await page.selectOption("#fRegen [name=templateId]", "builtin:gst");
  await page.click("#fRegen button[type=submit]");
  await page.waitForFunction(() => /PDF regenerated/.test(document.getElementById("toasts").textContent));
  check("Regenerate re-makes the PDF with another template", true);

  await page.click('[data-tab="templates"]');
  await page.locator('.tcard:has-text("Builder one") [data-act="tdel"]').click();
  await page.click('[data-act="tdelok"]');
  await page.waitForFunction(() => !/Builder one/.test(document.getElementById("tGrid").textContent));
  check("a template can be deleted", true);
  const tm = await ctx.newPage(); await tm.setViewportSize({ width: 390, height: 844 });
  await tm.goto(BASE); await tm.waitForSelector("#app:not([hidden])"); await tm.click('[data-tab="templates"]'); await tm.waitForSelector("#viewTemplates .tcard");
  check("mobile: Invoice Templates does not scroll the page sideways", !(await tm.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)));
  await tm.screenshot({ path: `${SHOTS}/12-templates-mobile.png` });
  await tm.close();

  // key is remembered across reload
  await page.reload();
  await page.waitForSelector("#app:not([hidden])");
  check("key is remembered after reload", true);

  check("no JavaScript errors in the console", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 300));
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("TEST CRASHED:", e.message.split("\n").slice(0, 6).join("\n")); process.exit(2); });
