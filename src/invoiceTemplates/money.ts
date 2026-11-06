/** Money helpers. Amounts are kept in paise (integers) while calculating so rounding never drifts. */

export const toPaise = (n: number) => Math.round(n * 100);
export const fromPaise = (p: number) => p / 100;

/** "₹1,18,000.00" for INR (Indian grouping); other currencies use their own symbol, same grouping. */
export function formatMoney(amount: number, currency = "INR"): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function below100(n: number): string { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`; }
function below1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? below100(r) : ""].filter(Boolean).join(" ");
}

/** Indian system: crore, lakh, thousand. 118000.5 -> "One Lakh Eighteen Thousand Rupees and Fifty Paise Only". */
export function amountInWords(amount: number, currency = "INR"): string {
  const paiseTotal = toPaise(Math.abs(amount));
  let rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000); rupees %= 10_000_000;
  const lakh = Math.floor(rupees / 100_000); rupees %= 100_000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) parts.push(`${crore >= 1000 ? amountInWords(crore, "").replace(/ Only$/, "") : crore >= 100 ? below1000(crore) : below100(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (rupees) parts.push(below1000(rupees));
  const main = parts.join(" ") || "Zero";
  const unit = currency === "INR" ? "Rupees" : currency;
  const words = `${main}${unit ? " " + unit : ""}${paise ? ` and ${below100(paise)} ${currency === "INR" ? "Paise" : "Cents"}` : ""}`;
  return `${words.trim()} Only`;
}
