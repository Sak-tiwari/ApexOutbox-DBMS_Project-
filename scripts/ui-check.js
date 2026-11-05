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
