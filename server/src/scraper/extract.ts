import { load } from "cheerio";
import { normalizeEmail, normalizePhone } from "../domain/normalize.js";

export interface Candidate {
  name: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  website: string;
  sourceUrl: string;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const IMAGE_SUFFIX = /\.(png|jpe?g|gif|svg|webp|ico|css|js)$/i;
const JUNK_LOCALPART = /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|webmaster|sentry|root)$/i;
const PREFERRED = /^(info|contact|hello|sales|enquiry|enquiries|support|office|admin|care)$/i;

const MAX_FIELD = 200;
// eslint-disable-next-line no-control-regex
const tidy = (s: string) => s.replace(/[\u0000-\u001f\u007f\ufffd]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_FIELD);

/** Public contact details found on one page. Pure: no network, no database. */
export function extractCandidate(html: string, pageUrl: string): Candidate | null {
  const $ = load(html);
  const origin = new URL(pageUrl).origin;

  const siteName = tidy($('meta[property="og:site_name"]').attr("content") ?? "");
  const title = tidy($("title").first().text());
  const h1 = tidy($("h1").first().text());
  const company = siteName || (title.split(/\s[|\-–—]\s/)[0] ?? "").trim() || h1;
  if (!company) return null;

  const found = new Set<string>();
  $('a[href^="mailto:" i]').each((_, el) => {
    const addr = decodeURIComponent(($(el).attr("href") ?? "").slice(7).split("?")[0] ?? "");
    found.add(addr);
  });
  // Visible text only (scripts/styles removed) so minified bundles do not yield fake addresses.
  $("script, style, noscript").remove();
  // Tags become spaces first, so text from neighbouring elements can never glue into a fake address.
  const spaced = ($("body").html() ?? "").replace(/<[^>]*>/g, " ");
  for (const m of load(`<p>${spaced}</p>`).root().text().matchAll(EMAIL_RE)) found.add(m[0]);

  const emails = [...found]
    .map((e) => normalizeEmail(e))
    .filter((e): e is string => !!e && !IMAGE_SUFFIX.test(e) && !JUNK_LOCALPART.test(e.split("@")[0]!) && e.length <= 254);
  const unique = [...new Set(emails)];
  const siteHost = new URL(pageUrl).hostname.replace(/^www\./, "");
  // Prefer an address on the site's own domain, then a role address (info@, contact@...).
  unique.sort((a, b) => score(b, siteHost) - score(a, siteHost));

  let phone: string | null = null;
  $('a[href^="tel:" i]').each((_, el) => {
    if (phone) return;
    phone = normalizePhone(decodeURIComponent(($(el).attr("href") ?? "").slice(4)));
  });

  return { name: company, companyName: company, email: unique[0] ?? null, phone, website: origin, sourceUrl: pageUrl.slice(0, 500) };
}

function score(email: string, siteHost: string): number {
  const [local, domain] = email.split("@") as [string, string];
  return (domain === siteHost || domain.endsWith(`.${siteHost}`) ? 2 : 0) + (PREFERRED.test(local) ? 1 : 0);
}
