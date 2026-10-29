
import "dotenv/config";
import nodemailer from "nodemailer";

interface EmailDetails {
  to: string;
  clientName: string;
  invoiceNumber: string;
  pdfPath: string;
}

export async function sendInvoiceEmail(
  details: EmailDetails
): Promise<{ messageId: string; demo: boolean }> {
  const {
    SMTP_HOST,
    SMTP_USER,
    SMTP_PASS,
    SMTP_PORT,
    EMAIL_FROM
  } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log("[DEMO EMAIL]", {
      to: details.to,
      invoiceNumber: details.invoiceNumber,
      pdfPath: details.pdfPath
    });

    return {
      messageId: `demo-${details.invoiceNumber}`,
      demo: true
    };
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT || 587) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  const result = await transporter.sendMail({
    from: EMAIL_FROM || SMTP_USER,
    to: details.to,
    subject: `Your invoice ${details.invoiceNumber}`,
    text: `Hi ${details.clientName},

Thank you for choosing us. Your invoice is attached.`,
    attachments: [
      {
        filename: `${details.invoiceNumber}.pdf`,
        path: details.pdfPath
      }
    ]
  });

  return {
    messageId: result.messageId,
    demo: false
  };
}
