const { Resend } = require('resend');
require('dotenv').config();

async function testResend() {
  console.log('Testing Resend email configuration...');
  console.log('RESEND_API_KEY:', process.env.RESEND_API_KEY ? '***configured***' : 'NOT SET');
  console.log('FROM_NAME:', process.env.FROM_NAME);

  if (!process.env.RESEND_API_KEY) {
    console.error('❌ RESEND_API_KEY is not set in .env file');
    return;
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);

    // Send test email
    const { data, error } = await resend.emails.send({
      from: `${process.env.FROM_NAME || 'Heedy'} <onboarding@resend.dev>`,
      to: ['muhammedminhaj798@gmail.com'], // Change this to your email
      subject: 'Test Email - Heedy Order System',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #111827;">Test Email</h1>
          <p>If you receive this, your Resend configuration is working correctly!</p>
          <p style="color: #666; font-size: 14px;">This email was sent from your Heedy backend using Resend API.</p>
        </div>
      `
    });

    if (error) {
      console.error('❌ Resend API error:', error);
      return;
    }

    console.log('✅ Test email sent successfully via Resend!');
    console.log('Email ID:', data.id);
    console.log('\n📧 Check your inbox at: muhammedminhaj798@gmail.com');
  } catch (error) {
    console.error('❌ Email test failed:');
    console.error(error.message);
  }
}

testResend();
