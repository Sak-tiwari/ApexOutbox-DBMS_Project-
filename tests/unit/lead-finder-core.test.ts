import { describe, expect, it } from "vitest";
import { parseBudget } from "../../src/leadFinder/budget";
import { fuzzyKey } from "../../src/leadFinder/dedupe";
import { matchesFilters } from "../../src/leadFinder/filters";
import { cleanKeywordList, extractKeywords, keywordsFromQuery } from "../../src/leadFinder/keywords";
import { scoreLead } from "../../src/leadFinder/score";

const NOW = Date.parse("2026-11-06T10:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

describe("keyword extraction (no LLM)", () => {
  it("expands 'we build websites' into related search terms", () => {
    const k = extractKeywords("We build websites for small businesses: React, WordPress, Shopify");
    expect(k).toEqual(expect.arrayContaining(["website", "web developer", "landing page", "wordpress", "shopify", "react"]));
    expect(k).not.toContain("we");
    expect(k).not.toContain("for");
    expect(k.length).toBeLessThanOrEqual(15);
    expect(new Set(k).size).toBe(k.length);
  });
  it("covers other services and keeps the user's own words", () => {
    expect(extractKeywords("I edit wedding videos and make logos")).toEqual(expect.arrayContaining(["video editing", "logo design", "wedding"]));
    expect(extractKeywords("blockchain auditing")).toEqual(["blockchain", "auditing"]);
  });
  it("manual query keeps the exact phrase first", () => {
    expect(keywordsFromQuery("React developer")[0]).toBe("react developer");
  });
  it("cleans a user-edited list: trims, lowercases, de-duplicates, drops junk", () => {
    expect(cleanKeywordList([" React ", "react", "", 5, "<b>x</b>", "a".repeat(100)])).toEqual(["react", "b x b", "a".repeat(40)]);
    expect(cleanKeywordList("nope")).toEqual([]);
  });
});

describe("match scoring", () => {
  const kws = ["web developer", "website", "shopify"];
  it("title hits beat description hits, and no hit scores 0", () => {
    const inTitle = scoreLead({ title: "Need a Shopify website", description: "", postedAt: hoursAgo(1) }, kws, NOW);
    const inDesc = scoreLead({ title: "Help wanted", description: "Our Shopify website is slow", postedAt: hoursAgo(1) }, kws, NOW);
    expect(inTitle).toBeGreaterThan(inDesc);
    expect(inDesc).toBeGreaterThan(0);
    expect(scoreLead({ title: "Plumber needed", description: "fix a leaking tap", postedAt: hoursAgo(1) }, kws, NOW)).toBe(0);
  });
  it("matches whole words only: 'art' is not found in 'start'", () => {
    expect(scoreLead({ title: "Start a company", description: "" }, ["art"], NOW)).toBe(0);
  });
  it("newer posts score higher than old ones with the same text", () => {
    const fresh = scoreLead({ title: "web developer for website", postedAt: hoursAgo(2) }, kws, NOW);
    const old = scoreLead({ title: "web developer for website", postedAt: hoursAgo(24 * 29) }, kws, NOW);
    expect(fresh).toBeGreaterThan(old);
  });
  it("stays between 1 and 100 and handles empty keyword lists", () => {
    const best = scoreLead({ title: "web developer website shopify", description: "web developer website shopify", postedAt: hoursAgo(0) }, kws, NOW);
    expect(best).toBeLessThanOrEqual(100);
    expect(best).toBeGreaterThan(80);
    expect(scoreLead({ title: "web developer" }, [], NOW)).toBe(0);
  });
  it("ignores regex characters in keywords", () => {
    expect(() => scoreLead({ title: "c++ developer (senior)" }, ["c++", "(senior)", "[x"], NOW)).not.toThrow();
    expect(scoreLead({ title: "c++ developer" }, ["c++"], NOW)).toBeGreaterThan(0);
  });
});

describe("cross-platform de-duplication key", () => {
  it("is the same for the same request worded with tags, case and filler", () => {
    expect(fuzzyKey("Kumar Dental", "[HIRING] Website redesign for dental clinic!")).toBe(fuzzyKey("kumar dental", "Need: dental clinic website redesign"));
  });
  it("differs for different companies or different work", () => {
    expect(fuzzyKey("A", "Shopify store")).not.toBe(fuzzyKey("B", "Shopify store"));
    expect(fuzzyKey("A", "Shopify store")).not.toBe(fuzzyKey("A", "Logo design"));
  });
});

describe("budget parsing", () => {
  it.each([
    ["$500", { min: 500, max: 500 }],
    ["$50-$100/hr", { min: 50, max: 100 }],
    ["USD 1,000 - 2,000", { min: 1000, max: 2000 }],
    ["₹25k", { min: 25000, max: 25000 }],
    ["budget 2k to 3k", { min: 2000, max: 3000 }],
    ["I have 3 pages", {}],
    ["", {}],
  ])("%s", (text, expected) => { expect(parseBudget(text)).toEqual(expected); });
});

describe("filters", () => {
  const base = { externalId: "1", title: "Website", url: "https://x.test" };
  it("posted within", () => {
    expect(matchesFilters({ ...base, postedAt: hoursAgo(30) }, { postedWithin: "24h" }, NOW)).toBe(false);
    expect(matchesFilters({ ...base, postedAt: hoursAgo(30) }, { postedWithin: "7d" }, NOW)).toBe(true);
    expect(matchesFilters(base, { postedWithin: "24h" }, NOW)).toBe(true); // unknown date is kept
  });
  it("budget range overlaps; unknown budget is kept", () => {
    const l = { ...base, budgetMin: 500, budgetMax: 1000 };
    expect(matchesFilters(l, { budgetMin: 1200 }, NOW)).toBe(false);
    expect(matchesFilters(l, { budgetMax: 400 }, NOW)).toBe(false);
    expect(matchesFilters(l, { budgetMin: 900, budgetMax: 5000 }, NOW)).toBe(true);
    expect(matchesFilters(base, { budgetMin: 900 }, NOW)).toBe(true);
  });
  it("location, remote and level", () => {
    expect(matchesFilters({ ...base, location: "Pune, India", remote: false }, { location: "india" }, NOW)).toBe(true);
    expect(matchesFilters({ ...base, location: "Berlin", remote: false }, { location: "india" }, NOW)).toBe(false);
    expect(matchesFilters({ ...base, location: "Berlin", remote: true }, { location: "india" }, NOW)).toBe(false);
    expect(matchesFilters({ ...base, location: "Anywhere", remote: true }, { location: "india" }, NOW)).toBe(true);
    expect(matchesFilters({ ...base, remote: false }, { remoteOnly: true }, NOW)).toBe(false);
    expect(matchesFilters({ ...base, title: "Senior React developer" }, { level: "entry" }, NOW)).toBe(false);
    expect(matchesFilters({ ...base, title: "Junior designer" }, { level: "senior" }, NOW)).toBe(false);
    expect(matchesFilters({ ...base, title: "Developer" }, { level: "mid" }, NOW)).toBe(true);
  });
});
