import { describe, expect, it } from "vitest";
import { extractFromHtml, primaryEmail } from "../../src/scraper/extract";

describe("email extraction", () => {
  it("finds mailto links and visible addresses, lowercased and de-duplicated", () => {
    const r = extractFromHtml('<title> Bloom   Bakery </title><a href="mailto:Orders@Bloom.test?subject=Hi">x</a><p>Write to orders@bloom.test or Help@Bloom.test.</p>');
    expect(r.title).toBe("Bloom Bakery");
    expect(r.emails).toEqual(["orders@bloom.test", "help@bloom.test"]);
  });
  it("does not glue neighbouring paragraphs or headings onto an address", () => {
    const html = "<p>Fresh cakes.</p><h2>Contact</h2><p>orders@bloom.test</p><ul><li>Press</li><li>press@bloom.test</li></ul><table><tr><td>x</td><td>y@bloom.test</td></tr></table>";
    expect(extractFromHtml(html).emails).toEqual(["orders@bloom.test", "press@bloom.test", "y@bloom.test"]);
  });
  it("decodes HTML entities used to hide the @", () => {
    expect(extractFromHtml("<p>write sales&#64;shop.test or ann&#x40;shop.test</p>").emails).toEqual(["sales@shop.test", "ann@shop.test"]);
  });
  it("understands simple obfuscation", () => {
    expect(extractFromHtml("<p>press [at] site [dot] test and sales (at) shop.test</p>").emails).toEqual(["press@site.test", "sales@shop.test"]);
  });
  it("ignores image names, script/style content and tracking ids", () => {
    const html = '<style>a{background:url(logo@2x.png)}</style><script>var e="hidden@script.test"</script><img src="logo@2x.png"><p>logo@2x.png 0123456789abcdef01234567@sentry.test real@firm.test</p>';
    expect(extractFromHtml(html).emails).toEqual(["real@firm.test"]);
  });
  it("copes with empty, huge and malformed input", () => {
    expect(extractFromHtml("")).toEqual({ title: "", emails: [] });
    expect(extractFromHtml('<a href="mailto:%E0%A4%A">bad</a>').emails).toEqual([]);
    const many = Array.from({ length: 100 }, (_, i) => `u${i}@many.test`).join(" ");
    expect(extractFromHtml(many).emails).toHaveLength(20);
    expect(extractFromHtml("x".repeat(3_000_000) + " late@after.test").emails).toEqual([]);
  });
  it("prefers a person's address over info@ and noreply@", () => {
    expect(primaryEmail(["noreply@a.test", "info@a.test", "ravi@a.test"])).toBe("ravi@a.test");
    expect(primaryEmail(["noreply@a.test", "info@a.test"])).toBe("info@a.test");
    expect(primaryEmail([])).toBeUndefined();
  });
});
