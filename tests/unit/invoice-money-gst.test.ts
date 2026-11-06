import { describe, expect, it } from "vitest";
import { computeTotals, stateFromGstin } from "../../src/invoiceTemplates/gst";
import { amountInWords, formatMoney } from "../../src/invoiceTemplates/money";
import { buildViewData, sampleSnapshot } from "../../src/invoiceTemplates/viewModel";

describe("Indian money formatting", () => {
  it.each([
    [0, "₹0.00"], [999.5, "₹999.50"], [100000, "₹1,00,000.00"], [12345678.9, "₹1,23,45,678.90"],
  ])("%s -> %s", (n, out) => { expect(formatMoney(n, "INR")).toBe(out); });
  it("uses the invoice currency", () => { expect(formatMoney(1500, "USD")).toMatch(/\$1,500\.00/); });
  it("falls back for an unknown currency code", () => { expect(formatMoney(5, "ZZZ")).toMatch(/5\.00/); });
});

describe("amount in words (lakh / crore)", () => {
  it.each([
    [0, "Zero Rupees Only"],
    [1, "One Rupees Only"],
    [118000, "One Lakh Eighteen Thousand Rupees Only"],
    [93220, "Ninety Three Thousand Two Hundred Twenty Rupees Only"],
    [12500000.5, "One Crore Twenty Five Lakh Rupees and Fifty Paise Only"],
    [999999999.99, "Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine Rupees and Ninety Nine Paise Only"],
  ])("%s", (n, words) => { expect(amountInWords(n, "INR")).toBe(words); });
});

describe("GST", () => {
  const items = [{ amount: 79000 }];
  const mh = { gstin: "27ABCDE1234F1Z5" }, mh2 = { gstin: "27PQRSX6789K1Z2" }, dl = { gstin: "07PQRSX6789K1Z2" };
  it("reads the state from a GSTIN", () => {
    expect(stateFromGstin("27ABCDE1234F1Z5")).toBe("Maharashtra");
    expect(stateFromGstin("07ABCDE1234F1Z5")).toBe("Delhi");
    expect(stateFromGstin("bad")).toBeUndefined();
  });
  it("same state: CGST + SGST, each half the rate", () => {
    expect(computeTotals(items, 18, mh, mh2)).toEqual({ subtotal: 79000, discount: 0, cgst: 7110, sgst: 7110, igst: 0, total: 93220, mode: "intra" });
  });
  it("different states: IGST at the full rate", () => {
    expect(computeTotals(items, 18, mh, dl)).toEqual({ subtotal: 79000, discount: 0, cgst: 0, sgst: 0, igst: 14220, total: 93220, mode: "inter" });
    expect(computeTotals(items, 18, { state: "Karnataka" }, { state: "Kerala" }).mode).toBe("inter");
  });
  it("unknown client state is treated as within the business's state", () => {
    expect(computeTotals(items, 18, mh, {}).mode).toBe("intra");
  });
  it("GSTIN wins over a typed state", () => {
    expect(computeTotals(items, 18, mh, { gstin: dl.gstin, state: "Maharashtra" }).mode).toBe("inter");
  });
  it("0% means no GST lines at all", () => {
    expect(computeTotals(items, 0, mh, dl)).toMatchObject({ cgst: 0, sgst: 0, igst: 0, total: 79000, mode: "none" });
  });
  it("rounds to the paisa without drift: CGST + SGST always add up", () => {
    const t = computeTotals([{ amount: 333.33 }], 5, mh, mh2);
    expect(t.cgst).toBe(8.33);
    expect(t.sgst).toBe(8.33);
    expect(t.total).toBeCloseTo(333.33 + 16.66, 2);
    const odd = computeTotals([{ amount: 0.1 }, { amount: 0.2 }], 18, mh, dl);
    expect(odd.subtotal).toBe(0.3);
    expect(odd.igst).toBe(0.05);
  });
  it("discount reduces the taxable value but never below zero", () => {
    expect(computeTotals(items, 18, mh, dl, 9000)).toMatchObject({ discount: 9000, igst: 12600, total: 82600 });
    expect(computeTotals(items, 18, mh, dl, 1e9).total).toBe(0);
  });
});

describe("template data", () => {
  it("formats everything for display and marks the tax type", () => {
    const d: any = buildViewData(sampleSnapshot(), { number: "INV-x" });
    expect(d.invoice.number).toBe("INV/2026/0042");
    expect(d.totals.total).toBe("₹93,220.00");
    expect(d.tax).toMatchObject({ is_intra: true, is_inter: false, cgst_rate: "9%", igst_rate: "0%", label: "CGST + SGST" });
    expect(d.items).toHaveLength(3);
    expect(d.items[0]).toMatchObject({ no: 1, qty: "1", amount: "₹45,000.00", tax_rate: "18%" });
    expect(d.payment.has_bank).toBe(true);
  });
  it("an invoice made before templates still renders: one line item, no GST", () => {
    const d: any = buildViewData({ clientName: "Old Co", email: "a@b.test", company: "", amount: 4999.5, currency: "INR", description: "Website", createdAt: new Date() }, { number: "INV-abc" });
    expect(d.invoice.number).toBe("INV-abc");
    expect(d.items).toEqual([expect.objectContaining({ description: "Website", amount: "₹4,999.50" })]);
    expect(d.totals.total).toBe("₹4,999.50");
    expect(d.tax.label).toBe("No GST");
    expect(d.business.name).toBe("");
  });
});
