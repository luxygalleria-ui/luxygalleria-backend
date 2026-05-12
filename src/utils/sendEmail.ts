import { Resend } from 'resend';

// Handle SSL certificate issues ONLY in local development
// Production (AWS, Vercel, etc.) has proper SSL certificates
// This only runs on your local machine where SSL verification fails
const isLocalDevelopment = process.env.NODE_ENV === 'development' && 
                          !process.env.AWS_EXECUTION_ENV && 
                          !process.env.VERCEL;

if (isLocalDevelopment) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendEmail = async (options: { email: string; subject: string; message?: string; html?: string }) => {
  try {
    // Resend requires a verified domain or use onboarding@resend.dev for testing
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
    const fromName = process.env.FROM_NAME || 'Heedy';

    const emailData: any = {
      from: `${fromName} <${fromEmail}>`,
      to: [options.email],
      subject: options.subject,
    };

    // Add either HTML or plain text
    if (options.html) {
      emailData.html = options.html;
    } else if (options.message) {
      emailData.text = options.message;
    }

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Resend API error:', error);
      throw new Error(`Failed to send email: ${error.message}`);
    }

    console.log('Email sent successfully via Resend:', data?.id);
    return data;
  } catch (err: any) {
    console.error('Failed to send email:', err);
    throw new Error(err.message || 'Failed to send email. Please check your Resend API key in .env');
  }
};
