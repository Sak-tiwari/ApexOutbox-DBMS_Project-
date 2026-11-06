/** Best-effort budget parsing from free text such as "$500", "$50-$100/hr", "USD 1,000 - 2,000", "₹25k". */
export function parseBudget(text: string | undefined): { min?: number; max?: number } {
  if (!text) return {};
  const t = text.toLowerCase().replace(/,/g, "");
  const nums = [...t.matchAll(/(?:[$€£₹]|usd|inr|eur|gbp|rs\.?)?\s?(\d+(?:\.\d+)?)\s?(k|m)?\b/g)]
    .map((m) => Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0 || !/[$€£₹]|usd|inr|eur|gbp|rs|budget|pay|rate|\/hr|per hour|k\b/.test(t)) return {};
  return nums.length === 1 ? { min: nums[0], max: nums[0] } : { min: Math.min(nums[0], nums[1]), max: Math.max(nums[0], nums[1]) };
}
