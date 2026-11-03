import { describe, expect, it } from "vitest";
import { formatMoney, priceInvoice, priceLine } from "../../src/invoices/money.js";

describe("priceLine", () => {
  it("multiplies quantity by unit price and applies tax in basis points", () => {
    expect(priceLine({ description: "x", quantity: 2, unitAmountMinor: 50_000, taxRateBp: 1800 })).toMatchObject({ subtotalMinor: 100_000, taxMinor: 18_000 });
  });
  it("rounds half-up on fractional quantities and on tax", () => {
    expect(priceLine({ description: "x", quantity: 1.5, unitAmountMinor: 333, taxRateBp: 0 }).subtotalMinor).toBe(500); // 499.5 -> 500
    expect(priceLine({ description: "x", quantity: 0.001, unitAmountMinor: 1, taxRateBp: 0 }).subtotalMinor).toBe(0);
    expect(priceLine({ description: "x", quantity: 1, unitAmountMinor: 25, taxRateBp: 1800 }).taxMinor).toBe(5); // 4.5 -> 5
    expect(priceLine({ description: "x", quantity: 1, unitAmountMinor: 24, taxRateBp: 1800 }).taxMinor).toBe(4); // 4.32 -> 4
  });
  it("is exact for amounts beyond floating-point precision", () => {
    const l = priceLine({ description: "x", quantity: 999_999.999, unitAmountMinor: 99_999_999_999, taxRateBp: 1800 });
    expect(l.subtotalMinor).toBe(Number((999_999_999n * 99_999_999_999n + 500n) / 1000n));
  });
});

describe("priceInvoice", () => {
  it("sums per-line rounded amounts so lines always add up to the total", () => {
    const r = priceInvoice([
      { description: "a", quantity: 1, unitAmountMinor: 25, taxRateBp: 1800 },
      { description: "b", quantity: 1, unitAmountMinor: 25, taxRateBp: 1800 },
    ]);
    expect(r).toMatchObject({ subtotalMinor: 50, taxMinor: 10, totalMinor: 60 }); // 5 + 5, not round(9.0)
    expect(r.lines.reduce((s, l) => s + l.subtotalMinor + l.taxMinor, 0)).toBe(r.totalMinor);
  });
  it("refuses totals that cannot be represented exactly", () => {
    const big = { description: "x", quantity: 1_000_000, unitAmountMinor: 100_000_000_000, taxRateBp: 10_000 };
    expect(() => priceInvoice([big, big, big, big, big, big, big, big, big, big])).toThrow(RangeError);
  });
});

describe("formatMoney", () => {
  it("uses Indian grouping for INR and thousands grouping otherwise", () => {
    expect(formatMoney(123_456_789, "INR")).toBe("INR 12,34,567.89");
    expect(formatMoney(100_000, "INR")).toBe("INR 1,000.00");
    expect(formatMoney(5, "INR")).toBe("INR 0.05");
    expect(formatMoney(123_456_789, "USD")).toBe("USD 1,234,567.89");
    expect(formatMoney(1500, "JPY")).toBe("JPY 1,500");
  });
});
