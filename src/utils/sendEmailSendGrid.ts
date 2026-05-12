// Alternative email implementation using SendGrid
// To use this: npm install @sendgrid/mail
// Then replace sendEmail.ts with this file

import sgMail from '@sendgrid/mail';

sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

export const sendEmail = async (options: { email: string; subject: string; message?: string; html?: string }) => {
  try {
    const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@heedy.com';
    const fromName = process.env.FROM_NAME || 'Heedy';

    const msg = {
      to: options.email,
      from: {
        email: fromEmail,
        name: fromName,
      },
      subject: options.subject,
      text: options.message || '',
      html: options.html || options.message || '',
    };

    const response = await sgMail.send(msg);
    console.log('Email sent successfully via SendGrid:', response[0].statusCode);
    return response;
  } catch (err: any) {
    console.error('Failed to send email via SendGrid:', err);
    if (err.response) {
      console.error('SendGrid error details:', err.response.body);
    }
    throw new Error(err.message || 'Failed to send email. Please check your SendGrid API key in .env');
  }
};
