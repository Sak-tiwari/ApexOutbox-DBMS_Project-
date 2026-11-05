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
    expect(extractFromHtml("")).toEqual({ title: "", emails: [], phones: [], contactLinks: [] });
    expect(extractFromHtml('<a href="mailto:%E0%A4%A">bad</a>').emails).toEqual([]);
    const many = Array.from({ length: 100 }, (_, i) => `u${i}@many.test`).join(" ");
    expect(extractFromHtml(many).emails).toHaveLength(20);
    expect(extractFromHtml("x".repeat(3_000_000) + " late@after.test").emails).toEqual([]);
  });
  it("finds phone numbers from tel: links and labelled text, not from prices or years", () => {
    const html = '<a href="tel:+91 98765-43210">call</a><p>Phone: 022 2345 6789</p><p>Open since 2015. Cakes from 1500 rupees. Call us on 98765 12345!</p><p>Ref 1234567890123456</p>';
    expect(extractFromHtml(html).phones).toEqual(["+919876543210", "02223456789", "9876512345"]);
    expect(extractFromHtml("<p>Price 1999 in 2024, 100% fresh</p>").phones).toEqual([]);
  });
  it("lists same-site Contact/About links only, at most two", () => {
    const html = '<a href="/contact">Contact</a><a href="/about-us">About</a><a href="/careers/contact-hr">x</a><a href="https://other.test/contact">Contact</a><a href="mailto:a@b.test">contact</a><a href="/products">Products</a>';
    expect(extractFromHtml(html, "https://shop.test/").contactLinks).toEqual(["https://shop.test/contact", "https://shop.test/about-us"]);
    expect(extractFromHtml(html).contactLinks).toEqual([]);
  });
  it("prefers a person's address over info@ and noreply@", () => {
    expect(primaryEmail(["noreply@a.test", "info@a.test", "ravi@a.test"])).toBe("ravi@a.test");
    expect(primaryEmail(["noreply@a.test", "info@a.test"])).toBe("info@a.test");
    expect(primaryEmail([])).toBeUndefined();
  });
});
