const nodemailer = require('nodemailer');

// Email configuration from environment variables
const CONFIG = {
  SMTP_HOST: process.env.SMTP_HOST || 'localhost',
  SMTP_PORT: process.env.SMTP_PORT || 587,
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  EMAIL_FROM: process.env.EMAIL_FROM || 'noreply@mudbot.local',
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000'
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

async function sendRegistrationEmail(email, token) {
  const loginLink = `${CONFIG.BASE_URL}/login?token=${token}&email=${encodeURIComponent(email)}`;
  
  const mailOptions = {
    from: CONFIG.EMAIL_FROM,
    to: email,
    subject: 'Mudbot - Your Login Link',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">Welcome to Mudbot</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
          <p style="font-size: 16px;">Hello,</p>
          <p style="font-size: 16px;">Click the button below to log in to your Mudbot account:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${loginLink}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 5px; font-size: 16px; font-weight: bold; display: inline-block;">Login to Mudbot</a>
          </div>
          <p style="font-size: 14px; color: #666;">Or copy and paste this link in your browser:</p>
          <p style="font-size: 12px; word-break: break-all; background: white; padding: 10px; border-radius: 5px; border: 1px solid #ddd;">${loginLink}</p>
          <p style="font-size: 14px; color: #666; margin-top: 30px;">This link will remain valid and can be used anytime to access your account.</p>
        </div>
        <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
          <p>© ${new Date().getFullYear()} Mudbot. All rights reserved.</p>
        </div>
      </body>
      </html>
    `,
    text: `
Welcome to Mudbot!

Click the link below to log in to your account:
${loginLink}

This link will remain valid and can be used anytime to access your account.

© ${new Date().getFullYear()} Mudbot. All rights reserved.
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

module.exports = {
  sendRegistrationEmail
};
