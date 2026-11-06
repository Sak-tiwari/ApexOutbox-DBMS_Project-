/** Every field a template can use, grouped as in the editor's reference panel. */
export const PLACEHOLDERS: Array<{ group: string; fields: Array<{ path: string; note: string }> }> = [
  { group: "Business", fields: [
    { path: "business.name", note: "Your business name" }, { path: "business.logo", note: "Logo image (use in <img src>)" },
    { path: "business.address", note: "Address" }, { path: "business.gstin", note: "GSTIN" }, { path: "business.state", note: "State" },
    { path: "business.email", note: "Email" }, { path: "business.phone", note: "Phone" },
  ] },
  { group: "Client", fields: [
    { path: "client.name", note: "Client name (required)" }, { path: "client.company", note: "Company" }, { path: "client.address", note: "Address" },
    { path: "client.gstin", note: "GSTIN" }, { path: "client.state", note: "State (place of supply)" }, { path: "client.email", note: "Email" },
  ] },
  { group: "Invoice", fields: [
    { path: "invoice.number", note: "Invoice number (required)" }, { path: "invoice.date", note: "Invoice date" }, { path: "invoice.due_date", note: "Due date" },
    { path: "invoice.currency", note: "Currency code, e.g. INR" }, { path: "invoice.status", note: "Status" }, { path: "invoice.is_paid", note: "True when the status is Paid (for {{#if}})" }, { path: "invoice.notes", note: "Notes" },
  ] },
  { group: "Items loop: {{#each items}} ... {{/each}}", fields: [
    { path: "items[].no", note: "Line number 1, 2, 3..." }, { path: "items[].description", note: "Description" }, { path: "items[].qty", note: "Quantity" },
    { path: "items[].rate", note: "Rate" }, { path: "items[].tax_rate", note: "GST rate, e.g. 18%" }, { path: "items[].amount", note: "Line amount" },
  ] },
  { group: "Totals", fields: [
    { path: "totals.subtotal", note: "Before tax" }, { path: "totals.discount", note: "Discount" }, { path: "totals.has_discount", note: "True when a discount applies (for {{#if}})" }, { path: "totals.cgst", note: "CGST (same state)" },
    { path: "totals.sgst", note: "SGST (same state)" }, { path: "totals.igst", note: "IGST (other state)" }, { path: "totals.total", note: "Total (required)" },
    { path: "totals.amount_in_words", note: "e.g. One Lakh Eighteen Thousand Rupees Only" },
  ] },
  { group: "Tax (for {{#if}})", fields: [
    { path: "tax.is_intra", note: "True when CGST + SGST apply" }, { path: "tax.is_inter", note: "True when IGST applies" }, { path: "tax.rate", note: "e.g. 18%" },
    { path: "tax.cgst_rate", note: "e.g. 9%" }, { path: "tax.sgst_rate", note: "e.g. 9%" }, { path: "tax.igst_rate", note: "e.g. 18%" }, { path: "tax.label", note: "CGST + SGST, IGST or No GST" },
  ] },
  { group: "Payment", fields: [
    { path: "payment.bank_name", note: "Bank" }, { path: "payment.account", note: "Account number" }, { path: "payment.ifsc", note: "IFSC" },
    { path: "payment.upi_id", note: "UPI ID" }, { path: "payment.qr", note: "Payment QR image (use in <img src>)" }, { path: "payment.link", note: "Payment link" },
    { path: "payment.has_bank", note: "True when bank details exist" },
  ] },
  { group: "Layout", fields: [
    { path: "brand.color", note: "Brand colour, e.g. #4f46e5" }, { path: "brand.font", note: "Font family" },
    { path: "cols.qty", note: "Show Qty column" }, { path: "cols.rate", note: "Show Rate column" }, { path: "cols.tax", note: "Show GST column" },
    { path: "doc.footer", note: "Footer text" }, { path: "doc.terms", note: "Terms" },
  ] },
];

export const ITEM_FIELDS = new Set(["no", "description", "qty", "rate", "tax_rate", "amount"]);
export const TOP_LEVEL_FIELDS = new Set(PLACEHOLDERS.flatMap((g) => g.fields.map((f) => f.path)).filter((p) => !p.startsWith("items[]")));
export const REQUIRED_FIELDS = ["invoice.number", "client.name", "totals.total"];
/** Fields that hold image data URIs, allowed in <img src>. */
export const IMAGE_FIELDS = new Set(["business.logo", "payment.qr"]);
