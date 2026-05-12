// Disable SSL verification for testing (not recommended for production)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { Resend } = require('resend');
require('dotenv').config();

async function testResendNoSSL() {
  console.log('='.repeat(70));
  console.log('RESEND TEST (SSL Verification Disabled)');
  console.log('='.repeat(70));
  console.log('\n⚠️  SSL verification is disabled for this test');
  console.log('   This helps diagnose network/firewall issues\n');
  
  const apiKey = process.env.RESEND_API_KEY;
  
  if (!apiKey) {
    console.error('❌ RESEND_API_KEY not found in .env');
    return;
  }

  console.log('API Key:', apiKey.substring(0, 10) + '...');
  console.log('\nAttempting to send test email...\n');

  try {
    const resend = new Resend(apiKey);
    
    const { data, error } = await resend.emails.send({
      from: 'Heedy <onboarding@resend.dev>',
      to: ['muhammedminhaj798@gmail.com'],
      subject: '✅ Resend Test - Heedy Order System',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #10b981;">✅ Success!</h1>
          <p>Your Resend API is working correctly!</p>
          <p style="background: #f0fdf4; border-left: 4px solid #10b981; padding: 15px; margin: 20px 0;">
            <strong>What this means:</strong><br>
            Your order confirmation emails will now be sent automatically when customers place orders.
          </p>
          <p style="color: #666; font-size: 14px;">
            Test sent at: ${new Date().toLocaleString()}
          </p>
        </div>
      `
    });

    if (error) {
      console.log('❌ Resend API Error:');
      console.log(JSON.stringify(error, null, 2));
      
      if (error.message && error.message.includes('API key')) {
        console.log('\n💡 Your API key appears to be invalid.');
        console.log('   Try generating a new one from: https://resend.com/api-keys');
      }
      return;
    }

    console.log('✅ SUCCESS! Email sent!');
    console.log('   Email ID:', data.id);
    console.log('\n📧 Check your inbox: muhammedminhaj798@gmail.com');
    console.log('\n🎉 Your order emails will now work!');
    console.log('\n' + '='.repeat(70));
    
  } catch (error) {
    console.log('❌ Error:', error.message);
    console.log('\nFull error:', error);
  }
}

testResendNoSSL();
