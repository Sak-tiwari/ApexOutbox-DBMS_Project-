import { fromPaise, toPaise } from "./money";

/** GST state codes (first two digits of a GSTIN). */
export const STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
  "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland",
  "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand",
  "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};
export const STATES = [...new Set(Object.values(STATE_CODES))].sort();

/** 15 characters: 2-digit state, PAN (5 letters, 4 digits, 1 letter), entity number, Z, checksum. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const GST_RATES = [0, 5, 12, 18, 28] as const;

export function stateFromGstin(gstin?: string): string | undefined {
  return gstin && GSTIN_RE.test(gstin) ? STATE_CODES[gstin.slice(0, 2)] : undefined;
}

export interface LineItem { description: string; qty: number; rate: number; taxRate: number; amount: number }
export interface Totals {
  subtotal: number; discount: number; cgst: number; sgst: number; igst: number; total: number;
  /** "intra" = same state (CGST + SGST), "inter" = different states (IGST), "none" = no GST. */
  mode: "intra" | "inter" | "none";
}

/**
 * GST on the taxable value. Same state -> CGST and SGST, each half the rate. Different states -> IGST at the full rate.
 * The state comes from the GSTIN when there is one, otherwise from the state picked in the form.
 * If the client's state is not known the supply is treated as within the business's state (the usual B2C case).
 */
export function computeTotals(items: Array<Pick<LineItem, "amount">>, gstRate: number, business: { gstin?: string; state?: string }, client: { gstin?: string; state?: string }, discount = 0): Totals {
  const subP = items.reduce((n, i) => n + toPaise(i.amount), 0);
  const discP = Math.min(toPaise(discount), subP);
  const taxable = subP - discP;
  const bState = stateFromGstin(business.gstin) ?? business.state;
  const cState = stateFromGstin(client.gstin) ?? client.state;
  if (!gstRate || gstRate <= 0) return { subtotal: fromPaise(subP), discount: fromPaise(discP), cgst: 0, sgst: 0, igst: 0, total: fromPaise(taxable), mode: "none" };
  const inter = !!(bState && cState && bState.toLowerCase() !== cState.toLowerCase());
  if (inter) {
    const igst = Math.round((taxable * gstRate) / 100);
    return { subtotal: fromPaise(subP), discount: fromPaise(discP), cgst: 0, sgst: 0, igst: fromPaise(igst), total: fromPaise(taxable + igst), mode: "inter" };
  }
  const half = Math.round((taxable * gstRate) / 200);
  return { subtotal: fromPaise(subP), discount: fromPaise(discP), cgst: fromPaise(half), sgst: fromPaise(half), igst: 0, total: fromPaise(taxable + 2 * half), mode: "intra" };
}
