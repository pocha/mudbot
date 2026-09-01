const nodemailer = require('nodemailer');

// Email configuration from environment variables
const CONFIG = {
  SMTP_HOST: process.env.SMTP_HOST || 'localhost',
  SMTP_PORT: process.env.SMTP_PORT || 587,
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  EMAIL_FROM: process.env.EMAIL_FROM || 'noreply@mudbot.local',
  REPLY_TO: process.env.REPLY_TO || '',
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
  // Where verify.html/logo.png actually live — the frontend (GitHub Pages
  // in production), not this VM's own BASE_URL (api.watobot.xyz). Locally
  // the VM still serves public/ on the same origin, so BASE_URL is reused.
  FRONTEND_BASE_URL: process.env.FRONTEND_BASE_URL || process.env.BASE_URL || 'http://localhost:3000'
};

// Create transporter
let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: CONFIG.SMTP_HOST,
      port: CONFIG.SMTP_PORT,
      secure: CONFIG.SMTP_SECURE,
      auth: CONFIG.SMTP_USER && CONFIG.SMTP_PASS ? {
        user: CONFIG.SMTP_USER,
        pass: CONFIG.SMTP_PASS
      } : undefined
    });
  }
  return transporter;
}

async function sendRegistrationEmail(email, token, { next = null } = {}) {
  const loginLink = `${CONFIG.FRONTEND_BASE_URL}/verify.html?token=${token}&email=${encodeURIComponent(email)}${next ? `&next=${encodeURIComponent(next)}` : ''}`;

  const mailOptions = {
    from: `Watobot <${CONFIG.EMAIL_FROM}>`,
    replyTo: CONFIG.REPLY_TO || undefined,
    to: email,
    subject: 'Watobot - Your Login Link',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; padding: 10px 0 20px;">
          <img src="${CONFIG.FRONTEND_BASE_URL}/logo.png" alt="Watobot" style="max-width: 180px; width: 100%; height: auto;" />
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 10px;">
          <p style="font-size: 16px;">Hello,</p>
          <p style="font-size: 16px;">Click the button below to log in to your Watobot account:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${loginLink}" style="background: linear-gradient(135deg, #006d2f 0%, #25d366 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: bold; display: inline-block;">Login to Watobot</a>
          </div>
          <p style="font-size: 14px; color: #666;">Or copy and paste this link in your browser:</p>
          <p style="font-size: 12px; word-break: break-all; background: white; padding: 10px; border-radius: 5px; border: 1px solid #ddd;">${loginLink}</p>
          <p style="font-size: 14px; color: #666; margin-top: 30px;">This link will remain valid and can be used anytime to access your account.</p>
          <p style="font-size: 14px; color: #666; margin-top: 20px;">This email comes from Ashish, the creator of Watobot — just reply to it if you'd like to reach him directly.</p>
        </div>
        <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
          <p>© ${new Date().getFullYear()} Watobot. All rights reserved.</p>
        </div>
      </body>
      </html>
    `,
    text: `
Welcome to Watobot!

Click the link below to log in to your account:
${loginLink}

This link will remain valid and can be used anytime to access your account.

This email comes from Ashish, the creator of Watobot — just reply to it if you'd like to reach him directly.

© ${new Date().getFullYear()} Watobot. All rights reserved.
    `
  };

  try {
    const info = await getTransporter().sendMail(mailOptions);
    console.log('Email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Email send error:', error);
    return { success: false, error: error.message };
  }
}

async function sendOwnerNotification(eventType, { userDir, country, city, email } = {}) {
  const notifyEmail = process.env.NOTIFY_EMAIL || process.env.REPLY_TO;
  if (!notifyEmail) return;

  const labels = {
    new_registration: 'New Registration',
    whatsapp_connected: 'WhatsApp Connected'
  };
  const subject = `Watobot: ${labels[eventType] || eventType}${email ? ` — ${email}` : ''}`;
  const location = [city, country ? country.toUpperCase() : null].filter(Boolean).join(', ');
  const lines = [
    `Event: ${labels[eventType] || eventType}`,
    email ? `Email: ${email}` : null,
    `User:  ${userDir}`,
    `Time:  ${new Date().toISOString()}`,
    location ? `Where: ${location}` : null,
    email ? '\nReply to this email to reach them directly.' : null
  ].filter(Boolean).join('\n');

  try {
    await getTransporter().sendMail({
      from: `Watobot <${CONFIG.EMAIL_FROM}>`,
      to: notifyEmail,
      replyTo: email || undefined,
      subject,
      text: lines
    });
  } catch { /* fire-and-forget — never surfaces to caller */ }
}

async function sendWhatsappRetryEmail(email, retryCount, userDir) {
  const notifyEmail = process.env.NOTIFY_EMAIL || process.env.REPLY_TO;
  if (!notifyEmail) return;

  const subject = `Watobot: WhatsApp Retry #${retryCount} — ${email}`;
  const text = [
    `User: ${email} (${userDir})`,
    `Retry count: ${retryCount}`,
    `Time: ${new Date().toISOString()}`,
    '',
    'They reported the WhatsApp device link did not complete and retried the QR scan.',
    'Reply to this email to reach them directly.'
  ].join('\n');

  try {
    await getTransporter().sendMail({
      from: `Watobot <${CONFIG.EMAIL_FROM}>`,
      to: notifyEmail,
      replyTo: email,
      subject,
      text
    });
  } catch { /* fire-and-forget — never surfaces to caller */ }
}

// Generic admin-only alert for a failed mudslide-touching API call — used
// directly in route handlers' catch blocks (routes/api.js) and reused below
// by sendMessageFailureNotification for its admin-side email, so the two
// don't duplicate the same sendMail boilerplate.
async function notifyOwnerOfError(action, userDir, error, extra = {}) {
  const notifyEmail = process.env.NOTIFY_EMAIL || process.env.REPLY_TO;
  if (!notifyEmail) return;

  const lines = [
    `Action: ${action}`,
    `User:   ${userDir}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    `Error:  ${error}`,
    `Time:   ${new Date().toISOString()}`
  ];

  try {
    await getTransporter().sendMail({
      from: `Watobot <${CONFIG.EMAIL_FROM}>`,
      to: notifyEmail,
      subject: `Watobot: ${action} failed — ${userDir}`,
      text: lines.join('\n')
    });
  } catch { /* fire-and-forget — never surfaces to caller */ }
}

// Fired when a sendMessage/sendMedia call fails (see withSession's finally
// block in services/mudslideService.js) — always alerts the admin
// (NOTIFY_EMAIL/REPLY_TO), and additionally the user's own opt-in address
// (services/userService.js's notify_email.enc) when they've set one.
async function sendMessageFailureNotification({ userDir, to, action, error, userEmail }) {
  const kind = action === 'sendMedia' ? 'media message' : 'message';

  const sends = [notifyOwnerOfError(action, userDir, error, { To: to || 'unknown' })];

  if (userEmail) {
    const userText = [
      `Hi,`,
      '',
      `We tried to send your ${kind} to ${to || 'the recipient'}, but it failed.`,
      '',
      `Error: ${error}`,
      '',
      'Check your dashboard and try again.',
      '',
      '— Watobot'
    ].join('\n');
    sends.push(getTransporter().sendMail({
      from: `Watobot <${CONFIG.EMAIL_FROM}>`,
      to: userEmail,
      subject: `Watobot: Your ${kind} failed to send`,
      text: userText
    }).catch(() => {}));
  }

  await Promise.all(sends);
}

// Fired by the hourly device-connection-check cron (see scripts/run-schedule.js)
// when confirmWhatsappIsActuallyConnected reports the device disconnected —
// same dual-recipient shape as sendMessageFailureNotification above.
async function notifyDeviceDisconnected(userDir, error, userEmail) {
  const sends = [notifyOwnerOfError('deviceDisconnected', userDir, error)];

  if (userEmail) {
    const userText = [
      `Hi,`,
      '',
      `Your WhatsApp connection appears to have dropped.`,
      '',
      `Error: ${error}`,
      '',
      'Please reconnect your device from your dashboard.',
      '',
      '— Watobot'
    ].join('\n');
    sends.push(getTransporter().sendMail({
      from: `Watobot <${CONFIG.EMAIL_FROM}>`,
      to: userEmail,
      subject: `Watobot: Your WhatsApp device is disconnected`,
      text: userText
    }).catch(() => {}));
  }

  await Promise.all(sends);
}

async function sendDailyReport(report, backupError = null) {
  const notifyEmail = process.env.NOTIFY_EMAIL || process.env.REPLY_TO;
  if (!notifyEmail) return;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  const total = report.reduce((s, r) => s + r.total, 0);
  const rows = report.map(r =>
    `${r.userDir}  |  Actions: ${r.total}`
  ).join('\n');

  const backupSection = backupError
    ? `\n\n⚠️ Data backup (git commit/push) failed:\n${backupError}`
    : '';

  try {
    await getTransporter().sendMail({
      from: `Watobot <${CONFIG.EMAIL_FROM}>`,
      to: notifyEmail,
      subject: `Watobot Daily Report — ${dateStr}${backupError ? ' [backup failed]' : ''}`,
      text: `Daily Activity Report for ${dateStr}\n\nTotal actions across all users: ${total}\n\nBreakdown by user:\n\n${rows}${backupSection}`
    });
  } catch (e) {
    console.error('Failed to send daily report:', e.message);
  }
}

module.exports = {
  sendRegistrationEmail,
  sendOwnerNotification,
  sendWhatsappRetryEmail,
  notifyOwnerOfError,
  sendMessageFailureNotification,
  notifyDeviceDisconnected,
  sendDailyReport
};
