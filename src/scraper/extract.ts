import { load } from "cheerio";

export interface Extracted {
  title: string;
  emails: string[];
}

// Every part is length-bounded so a huge page of letters or spaces cannot make matching quadratic (ReDoS).
const EMAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,6}\.[a-z]{2,24}/gi;
const FILE_SUFFIX = /\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|pdf|mp4)$/i;
const MAX_EMAILS = 20;
const MAX_HTML = 2_000_000;

/** Turns "name [at] site [dot] com" and "name (at) site.com" into a normal address. */
function deobfuscate(text: string): string {
  return text
    .replace(/\s{0,3}[\[(]\s{0,3}at\s{0,3}[\])]\s{0,3}/gi, "@")
    .replace(/\s{0,3}[\[(]\s{0,3}dot\s{0,3}[\])]\s{0,3}/gi, ".");
}

function clean(raw: string): string | null {
  const email = raw.toLowerCase().replace(/^[._%+-]+/, "");
  if (email.length > 254 || FILE_SUFFIX.test(email)) return null;
  const [local, domain] = email.split("@");
  if (!local || !domain || local.length > 64) return null;
  // Image names such as logo@2x.png and tracking ids (long hex before the @) are not people.
  if (/^[0-9a-f]{24,}$/.test(local)) return null;
  return email;
}

export function extractFromHtml(html: string): Extracted {
  const $ = load(html.slice(0, MAX_HTML));
  const title = $("title").first().text().replace(/\s+/g, " ").trim().slice(0, 200);

  const found: string[] = [];
  // mailto: links first - they are the addresses the site owner chose to publish.
  $("a[href^='mailto:' i]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").slice(7).split("?")[0];
    try {
      found.push(...(decodeURIComponent(href).match(EMAIL) ?? []));
    } catch { /* malformed escape: ignore this link */ }
  });
  $("script, style, noscript").remove();
  // Tags become spaces first: otherwise "<p>cakes.</p><h2>Contact</h2><p>a@b.test</p>" reads as "cakes.Contacta@b.test".
  // Re-parsing the result decodes entities such as &#64; (a common way to hide the @).
  const text = load("<body>" + ($("body").html() ?? $.root().html() ?? "").replace(/<[^>]*>/g, " ") + "</body>").text();
  found.push(...(deobfuscate(text).match(EMAIL) ?? []));

  const emails: string[] = [];
  for (const raw of found) {
    const email = clean(raw);
    if (email && !emails.includes(email)) emails.push(email);
    if (emails.length >= MAX_EMAILS) break;
  }
  return { title, emails };
}

/** Best contact address for the lead card: a person-like address beats info@/noreply@. */
export function primaryEmail(emails: string[]): string | undefined {
  const score = (e: string) => (/^(no-?reply|donotreply|do-not-reply|mailer-daemon)@/.test(e) ? 2 : /^(info|contact|hello|admin|support|sales|office)@/.test(e) ? 1 : 0);
  return [...emails].sort((a, b) => score(a) - score(b))[0];
}
