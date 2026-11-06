import type { LeadSource, RawLead } from "../types";

const H = 3_600_000;
// Sample posts for demos when live sites block scraping (LEAD_FINDER_MOCK=true). Clearly fictional.
const SAMPLES: Array<[string, string, string, string, string, number, number, number, string, boolean]> = [
  // id, company, title, description, platform label, budgetMin, budgetMax, hoursAgo, location, remote
  ["m01", "Greenleaf Organics", "Need a Shopify store for our organic produce brand", "We sell organic vegetables and want a clean Shopify store with subscriptions, delivery slots and a blog. Design assets are ready.", "Sample", 800, 1500, 3, "Pune, India", false],
  ["m02", "Kumar Dental Care", "Website redesign for dental clinic", "Our WordPress website is old. Looking for a web developer to redesign it, add online appointment booking and make it fast on mobile.", "Sample", 400, 700, 9, "Mumbai, India", false],
  ["m03", "Bright Bakes", "Landing page for cake delivery business", "Single landing page with WhatsApp order button and gallery. React or plain HTML is fine.", "Sample", 150, 300, 26, "Remote", true],
  ["m04", "FitNest Studio", "React developer for gym membership web app", "We need a React front end for member sign-ups, class booking and payments (Razorpay). Backend API exists.", "Sample", 1500, 3000, 50, "Delhi, India", false],
  ["m05", "Urban Threads", "Ecommerce website with WooCommerce", "Fashion store with 200 products, size filters and COD. WordPress + WooCommerce preferred.", "Sample", 600, 1200, 70, "Remote", true],
  ["m06", "Sunrise Realty", "Real estate listing website with search", "Property listings with filters, map and enquiry forms. Admin panel to add listings.", "Sample", 2000, 4000, 120, "Gurgaon, India", false],
  ["m07", "Novatech Labs", "Flutter developer for delivery app", "Customer and rider apps for a local delivery startup. Firebase backend.", "Sample", 3000, 6000, 20, "Remote", true],
  ["m08", "Pixel & Co", "Logo and brand identity for coffee shop", "Need a logo, colour palette and menu design for a new cafe.", "Sample", 100, 250, 5, "Remote", true],
  ["m09", "Lotus Wellness", "SEO and content for yoga studio website", "Monthly SEO, 4 blog posts a month and Google Business profile help.", "Sample", 200, 400, 40, "Remote", true],
  ["m10", "ReelWorks", "Video editor for Instagram reels", "Edit 12 reels per month from raw footage, with captions and music.", "Sample", 150, 300, 15, "Remote", true],
  ["m11", "Taylor Accounting", "Python script to scrape invoices into spreadsheet", "Automate extracting data from PDF invoices into Google Sheets.", "Sample", 100, 250, 200, "Remote", true],
  ["m12", "Orchid Salon", "Website and online booking for salon", "Simple 5-page site with a booking form and Instagram feed.", "Sample", 300, 500, 8, "Ghaziabad, India", false],
  ["m13", "EduSpark Tutors", "Build a learning portal with login and payments", "Students log in, watch recorded classes and pay monthly. React + Node.", "Sample", 2500, 5000, 90, "Remote", true],
  ["m14", "Harbor Cafe", "Fix our Wix website and move to WordPress", "Move content from Wix to WordPress, keep SEO rankings.", "Sample", 200, 400, 300, "Remote", true],
  ["m15", "Peak Gear", "Shopify theme customisation (senior developer)", "Need a senior Shopify developer for custom Liquid sections and speed optimisation.", "Sample", 1000, 2000, 30, "Remote", true],
  ["m16", "Quill Publishing", "Blog writer for tech articles", "Four 1,200-word articles per month on web development topics.", "Sample", 120, 240, 60, "Remote", true],
];

export function mockSource(): LeadSource {
  return {
    id: "mock",
    name: "Sample data (demo)",
    async search() {
      const now = Date.now();
      return SAMPLES.map(([id, company, title, description, , min, max, hoursAgo, location, remote]): RawLead => ({
        externalId: id,
        title,
        company,
        description,
        url: `https://example.com/sample-requests/${id}`,
        budgetText: `$${min}–$${max}`,
        budgetMin: min,
        budgetMax: max,
        location,
        remote,
        postedAt: new Date(now - hoursAgo * H),
      }));
    },
  };
}
