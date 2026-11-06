import { chromium, type Browser } from "playwright-core";

/**
 * HTML -> PDF in headless Chromium, locked down for untrusted markup:
 *   - JavaScript is disabled for the page
 *   - every network request is aborted (images and fonts arrive as data: URIs, already inside the HTML)
 *   - a hard timeout; the page and its context are always closed
 * One browser is shared and started on first use.
 */
let browserPromise: Promise<Browser> | null = null;
export const RENDER_TIMEOUT_MS = 15_000;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // CHROMIUM_PATH: use a system Chromium (e.g. Alpine Docker image) instead of the Playwright download.
    browserPromise = chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--disable-gpu", "--no-first-run"] }).catch((e) => {
      browserPromise = null;
      throw new Error(`Chromium could not start (${String(e.message).split("\n")[0]}). Run: npx playwright install chromium`);
    });
  }
  const b = await browserPromise;
  if (!b.isConnected()) { browserPromise = null; return getBrowser(); }
  return b;
}

export async function closeRenderer(): Promise<void> {
  const p = browserPromise; browserPromise = null;
  if (p) await (await p.catch(() => null))?.close().catch(() => undefined);
}

export interface RenderStats { blockedRequests: string[] }

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took longer than ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t));
}

// At most 3 renders at once per process: each one is a browser page.
let active = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

export function htmlToPdf(html: string, opts: { timeoutMs?: number; stats?: RenderStats } = {}): Promise<Buffer> {
  return slot(() => renderNow(html, opts));
}

async function renderNow(html: string, opts: { timeoutMs?: number; stats?: RenderStats }): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext({ javaScriptEnabled: false, offline: true, acceptDownloads: false, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => { opts.stats?.blockedRequests.push(route.request().url().slice(0, 200)); return route.abort("blockedbyclient"); });
    return await withTimeout((async () => {
      await page.setContent(html, { waitUntil: "load", timeout: opts.timeoutMs ?? RENDER_TIMEOUT_MS });
      return page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    })(), opts.timeoutMs ?? RENDER_TIMEOUT_MS, "Rendering the PDF");
  } finally {
    await context.close().catch(() => undefined);
  }
}
