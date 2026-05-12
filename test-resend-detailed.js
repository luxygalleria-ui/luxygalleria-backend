const { Resend } = require('resend');
require('dotenv').config();

async function testResendDetailed() {
  console.log('='.repeat(70));
  console.log('RESEND API KEY VALIDATION TEST');
  console.log('='.repeat(70));
  
  const apiKey = process.env.RESEND_API_KEY;
  
  console.log('\n1. Checking API Key Format:');
  console.log('   API Key exists:', apiKey ? '✅ Yes' : '❌ No');
  console.log('   API Key length:', apiKey ? apiKey.length : 0);
  console.log('   Starts with "re_":', apiKey?.startsWith('re_') ? '✅ Yes' : '❌ No');
  console.log('   First 10 chars:', apiKey ? apiKey.substring(0, 10) + '...' : 'N/A');
  
  if (!apiKey) {
    console.error('\n❌ RESEND_API_KEY is not set in .env file');
    console.log('\n📝 Steps to fix:');
    console.log('   1. Go to https://resend.com/login');
    console.log('   2. Navigate to API Keys');
    console.log('   3. Create a new API key');
    console.log('   4. Copy the key (starts with re_)');
    console.log('   5. Update .env file: RESEND_API_KEY=re_your_key_here');
    return;
  }

  console.log('\n2. Testing Resend Connection:');
  
  try {
    const resend = new Resend(apiKey);
    
    console.log('   Resend client created: ✅');
    console.log('   Attempting to send test email...');
    
    const { data, error } = await resend.emails.send({
      from: 'Heedy Test <onboarding@resend.dev>',
      to: ['muhammedminhaj798@gmail.com'],
      subject: 'Test Email - Heedy Order System',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #111827;">✅ Resend is Working!</h1>
          <p>Congratulations! Your Resend API key is valid and working correctly.</p>
          <p style="color: #666; font-size: 14px;">
            This means your order confirmation emails will now be sent automatically when customers place orders.
          </p>
          <hr style="border: 1px solid #eee; margin: 20px 0;">
          <p style="color: #999; font-size: 12px;">
            Sent from Heedy Backend at ${new Date().toLocaleString()}
          </p>
        </div>
      `
    });

    if (error) {
      console.log('\n❌ Resend API Error:');
      console.log('   Error name:', error.name);
      console.log('   Error message:', error.message);
      console.log('   Status code:', error.statusCode);
      
      if (error.name === 'validation_error') {
        console.log('\n💡 This is a validation error. Common causes:');
        console.log('   - Invalid email format');
        console.log('   - Missing required fields');
        console.log('   - Invalid from address');
      } else if (error.name === 'application_error') {
        console.log('\n💡 This is an application error. Common causes:');
        console.log('   - Invalid or expired API key');
        console.log('   - Network connectivity issues');
        console.log('   - Resend service temporarily unavailable');
        console.log('\n🔧 Try these fixes:');
        console.log('   1. Generate a NEW API key from https://resend.com/api-keys');
        console.log('   2. Make sure you copied the ENTIRE key');
        console.log('   3. Check for extra spaces in .env file');
        console.log('   4. Try again in a few minutes');
      }
      
      return;
    }

    console.log('\n✅ SUCCESS! Email sent successfully!');
    console.log('   Email ID:', data.id);
    console.log('   From:', 'Heedy Test <onboarding@resend.dev>');
    console.log('   To:', 'muhammedminhaj798@gmail.com');
    console.log('\n📧 Check your inbox! You should receive the test email shortly.');
    console.log('\n🎉 Your order confirmation emails will now work!');
    
  } catch (error) {
    console.log('\n❌ Unexpected Error:');
    console.log('   Error:', error.message);
    console.log('   Stack:', error.stack);
  }
  
  console.log('\n' + '='.repeat(70));
}

testResendDetailed();
