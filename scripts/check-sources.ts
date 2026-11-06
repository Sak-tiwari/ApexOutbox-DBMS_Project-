/**
 * Checks every live Lead Finder source from THIS machine's network and prints what each one returns.
 *   npx tsx scripts/check-sources.ts
 * Use it to see which sites are reachable from your connection before relying on them.
 */
import { createHttp } from "../src/leadFinder/http";
import { scoreLead } from "../src/leadFinder/score";
import { liveSources } from "../src/leadFinder/sources";

(async () => {
  const http = createHttp({ minIntervalMs: 1000 });
  const keywords = ["website", "web developer", "wordpress", "shopify", "react", "logo design"];
  let anyOk = false;
  for (const s of liveSources()) {
    const t = Date.now();
    try {
      const leads = await s.search({ keywords, filters: {} }, http);
      const matching = leads.filter((l) => scoreLead(l, keywords) >= 10);
      anyOk = anyOk || leads.length > 0;
      console.log(`OK       ${s.name.padEnd(34)} ${String(leads.length).padStart(4)} posts read, ${String(matching.length).padStart(3)} match your keywords (${Date.now() - t} ms)`);
      for (const l of matching.slice(0, 2)) console.log(`           - ${l.title.slice(0, 80)}  ${l.url}`);
    } catch (e) {
      console.log(`${(e as Error).name === "SourceBlockedError" ? "BLOCKED " : "FAILED  "} ${s.name.padEnd(34)} ${(e as Error).message}`);
    }
  }
  console.log(anyOk ? "\nAt least one live source works from this network." : "\nNo live source answered. Check your internet connection, or use LEAD_FINDER_MOCK=true for demo data.");
  process.exit(0);
})();
