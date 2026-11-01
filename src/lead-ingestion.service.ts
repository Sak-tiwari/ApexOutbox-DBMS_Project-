import { Lead } from "./models/Lead";

type LeadInput = {
  website: string;
  title: string;
  emails: string[];
  source: string;
  scrapedAt: string;
};

function normalizeWebsite(value: string): string {
  const url = new URL(value.trim());

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Invalid website protocol");
  }

  if (url.username || url.password) {
    throw new Error("Website credentials are not allowed");
  }

  return url.origin.toLowerCase();
}

function normalizeEmail(email: string): string | null {
  const value = email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return null;
  }

  return value;
}

export async function saveLeads(data: LeadInput) {
  const website = normalizeWebsite(data.website);
  const title = data.title.trim();

  if (!title) {
    throw new Error("Lead title is required");
  }

  const validEmails = [
    ...new Set(
      data.emails
        .map(normalizeEmail)
        .filter((email): email is string => email !== null)
    )
  ];

 const emails: (string | null)[] =
  validEmails.length > 0 ? validEmails : [null];

  const scrapedAt = new Date(data.scrapedAt);

  if (Number.isNaN(scrapedAt.getTime())) {
    throw new Error("Invalid scrapedAt date");
  }

  return Promise.all(
    emails.map((email) => {
     const dedupeKey = website + "|" + (email ?? "no-email");

      return Lead.updateOne(
        { dedupeKey },
        {
          $set: {
            website,
            title,
            email,
            source: data.source.trim(),
            scrapedAt
          }
        },
        { upsert: true }
      );
    })
  );
}