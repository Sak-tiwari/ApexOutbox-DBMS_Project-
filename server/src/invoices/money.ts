/**
 * Money is integer minor units (paise for INR); tax rates are basis points (1800 = 18%).
 * All arithmetic uses BigInt so large amounts can never lose precision, and rounding is explicit:
 * half-up, per line, tax computed on each line's subtotal. The invoice total is the sum of its lines.
 */
export const MAX_UNIT_MINOR = 100_000_000_000; // 1 billion major units
export const MAX_QUANTITY = 1_000_000;

export interface LineInput {
  description: string;
  quantity: number;
  unitAmountMinor: number;
  taxRateBp: number;
}
export interface PricedLine extends LineInput {
  subtotalMinor: number;
  taxMinor: number;
}

const roundDiv = (num: bigint, den: bigint) => (num * 2n + den) / (den * 2n); // half-up for non-negative values

export function priceLine(line: LineInput): PricedLine {
  const milli = BigInt(Math.round(line.quantity * 1000)); // quantities have at most 3 decimals
  const subtotal = roundDiv(milli * BigInt(line.unitAmountMinor), 1000n);
  const tax = roundDiv(subtotal * BigInt(line.taxRateBp), 10_000n);
  return { ...line, subtotalMinor: Number(subtotal), taxMinor: Number(tax) };
}

export function priceInvoice(lines: LineInput[]) {
  const priced = lines.map(priceLine);
  const subtotal = priced.reduce((s, l) => s + BigInt(l.subtotalMinor), 0n);
  const tax = priced.reduce((s, l) => s + BigInt(l.taxMinor), 0n);
  const total = subtotal + tax;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Invoice total is too large");
  return { lines: priced, subtotalMinor: Number(subtotal), taxMinor: Number(tax), totalMinor: Number(total) };
}

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND"]);
export function formatMoney(minor: number, currency: string): string {
  const digits = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const major = digits === 0 ? String(minor) : `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
  const [int, frac] = major.split(".");
  const grouped = groupDigits(int!, currency === "INR");
  return `${currency} ${grouped}${frac ? `.${frac}` : ""}`;
}

/** Indian grouping (12,34,567) for INR, thousands grouping (1,234,567) otherwise. */
function groupDigits(int: string, indian: boolean): string {
  if (indian && int.length > 3) return `${int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${int.slice(-3)}`;
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
