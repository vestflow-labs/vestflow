const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.NOTIFICATION_FROM_EMAIL || "noreply@vestflow.xyz";
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://vestflow.xyz";

interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

async function sendEmail(to: string, content: EmailContent): Promise<void> {
  if (!SENDGRID_API_KEY) {
    console.warn("SENDGRID_API_KEY not configured. Email not sent to:", to);
    return;
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL },
      subject: content.subject,
      content: [
        { type: "text/plain", value: content.text },
        { type: "text/html", value: content.html },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`SendGrid error: ${response.status} ${response.statusText}`);
  }
}

export async function sendCliffReachedNotification(
  email: string,
  scheduleId: number,
  beneficiaryAddress: string,
  cliffDate: Date
): Promise<void> {
  const scheduleUrl = `${BASE_URL}/schedule/${scheduleId}`;
  await sendEmail(email, {
    subject: `Cliff Reached - Schedule #${scheduleId}`,
    text: [
      "Your vesting schedule has reached its cliff.",
      `Schedule ID: ${scheduleId}`,
      `Beneficiary: ${beneficiaryAddress}`,
      `Cliff Date: ${cliffDate.toLocaleDateString()}`,
      `View schedule: ${scheduleUrl}`,
    ].join("\n"),
    html: `<p>Your vesting schedule has reached its cliff.</p><p><a href="${scheduleUrl}">View schedule #${scheduleId}</a></p>`,
  });
}

export async function sendClaimableNotification(
  email: string,
  scheduleId: number,
  claimableAmount: string,
  claimableDate: Date
): Promise<void> {
  const scheduleUrl = `${BASE_URL}/schedule/${scheduleId}`;
  await sendEmail(email, {
    subject: `Tokens Now Claimable - Schedule #${scheduleId}`,
    text: [
      "Your tokens are now claimable.",
      `Schedule ID: ${scheduleId}`,
      `Claimable Amount: ${claimableAmount} XLM`,
      `Available Since: ${claimableDate.toLocaleDateString()}`,
      `View schedule: ${scheduleUrl}`,
    ].join("\n"),
    html: `<p>${claimableAmount} XLM is now claimable.</p><p><a href="${scheduleUrl}">View schedule #${scheduleId}</a></p>`,
  });
}

export async function sendRevokedNotification(
  email: string,
  scheduleId: number,
  revokedDate: Date
): Promise<void> {
  const scheduleUrl = `${BASE_URL}/schedule/${scheduleId}`;
  await sendEmail(email, {
    subject: `Schedule Revoked - Schedule #${scheduleId}`,
    text: [
      "Your vesting schedule has been revoked.",
      `Schedule ID: ${scheduleId}`,
      `Revoked Date: ${revokedDate.toLocaleDateString()}`,
      `View schedule: ${scheduleUrl}`,
    ].join("\n"),
    html: `<p>Your vesting schedule has been revoked.</p><p><a href="${scheduleUrl}">View schedule #${scheduleId}</a></p>`,
  });
}
