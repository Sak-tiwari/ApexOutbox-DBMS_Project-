import { Lead } from "./models/Lead";

type LeadInput = {
  website: string;
  title: string;
  emails: string[];
  source: string;
  scrapedAt: string;
};

export async function saveLeads(data: LeadInput) {
  const emails: (string | null)[] =
    data.emails.length > 0 ? data.emails : [null];

  const results = await Promise.all(
    emails.map((email) => {
      const normalizedEmail = email
        ? email.trim().toLowerCase()
        : null;

      const dedupeKey = normalizedEmail
        ? data.website.toLowerCase() + "|" + normalizedEmail
        : data.website.toLowerCase() + "|no-email";

      return Lead.updateOne(
        { dedupeKey },
        {
          $set: {
            website: data.website,
            title: data.title,
            email: normalizedEmail,
            source: data.source,
            scrapedAt: new Date(data.scrapedAt)
          }
        },
        { upsert: true }
      );
    })
  );

  return results;
}

