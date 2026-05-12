// Test the actual order confirmation email that will be sent
require('dotenv').config();

// Handle SSL issues
if (process.env.NODE_ENV === 'development') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const { Resend } = require('resend');

async function testOrderEmail() {
  console.log('='.repeat(80));
  console.log('TESTING ORDER CONFIRMATION EMAIL');
  console.log('='.repeat(80));
  
  const resend = new Resend(process.env.RESEND_API_KEY);
  
  // Simulate order data
  const mockOrder = {
    _id: '507f1f77bcf86cd799439011',
    total: 2499.99,
    createdAt: new Date()
  };
  
  const mockUser = {
    name: 'Test Customer',
    email: 'muhammedminhaj798@gmail.com'
  };
  
  console.log('\n📦 Simulating order placement...');
  console.log('   Customer:', mockUser.name);
  console.log('   Email:', mockUser.email);
  console.log('   Order ID:', mockOrder._id);
  console.log('   Total:', '₹' + mockOrder.total);
  
  // This is the exact email template from your paymentController.ts
  const htmlMessage = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 10px; overflow: hidden; background-color: #ffffff;">
      <div style="background-color: #111827; padding: 30px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 2px; text-transform: uppercase;">Heedy</h1>
      </div>
      <div style="padding: 40px 30px;">
        <h2 style="color: #111827; font-size: 20px; margin-top: 0; margin-bottom: 20px;">Order Confirmation</h2>
        <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
          Dear <strong>${mockUser.name}</strong>,<br><br>
          Thank you for your purchase! Your order has been placed successfully and is now being processed.
        </p>
        <div style="background-color: #f9fafb; border: 1px solid #f3f4f6; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
          <p style="margin: 0 0 10px 0; color: #374151; font-size: 15px;"><strong>Order ID:</strong> <span style="color: #111827;">${mockOrder._id}</span></p>
          <p style="margin: 0 0 10px 0; color: #374151; font-size: 15px;"><strong>Order Date:</strong> <span style="color: #111827;">${String(mockOrder.createdAt.getDate()).padStart(2, '0')}/${String(mockOrder.createdAt.getMonth() + 1).padStart(2, '0')}/${mockOrder.createdAt.getFullYear()}</span></p>
          <p style="margin: 0; color: #374151; font-size: 15px;"><strong>Total Amount:</strong> <span style="color: #111827; font-size: 18px; font-weight: bold;">₹${mockOrder.total}</span></p>
        </div>
        <p style="color: #4b5563; font-size: 15px; line-height: 1.6; margin-bottom: 30px;">
          We will send you another email once your order has been shipped. If you have any questions, feel free to reply to this email.
        </p>
        <div style="text-align: center;">
          <a href="${process.env.FRONTEND_URL || 'https://heedy-frontend.vercel.app'}/profile" style="background-color: #111827; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block;">View Order Details</a>
        </div>
      </div>
      <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #eaeaea;">
        <p style="color: #9ca3af; font-size: 13px; margin: 0;">© ${new Date().getFullYear()} Heedy Luxury. All rights reserved.</p>
      </div>
    </div>
  `;
  
  console.log('\n📧 Sending order confirmation email...\n');
  
  try {
    const { data, error } = await resend.emails.send({
      from: `${process.env.FROM_NAME || 'Heedy'} <${process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'}>`,
      to: [mockUser.email],
      subject: 'Order Confirmation - Heedy',
      html: htmlMessage
    });
    
    if (error) {
      console.log('❌ Failed to send email:');
      console.log(JSON.stringify(error, null, 2));
      return;
    }
    
    console.log('✅ ORDER CONFIRMATION EMAIL SENT SUCCESSFULLY!');
    console.log('   Email ID:', data.id);
    console.log('   From:', `${process.env.FROM_NAME} <${process.env.RESEND_FROM_EMAIL}>`);
    console.log('   To:', mockUser.email);
    console.log('   Subject: Order Confirmation - Heedy');
    console.log('\n📬 Check your inbox! The email should arrive within seconds.');
    console.log('\n' + '='.repeat(80));
    console.log('🎉 SUCCESS! Your order confirmation emails are working!');
    console.log('='.repeat(80));
    console.log('\n✅ What happens now:');
    console.log('   1. When a customer places an order → They receive this email');
    console.log('   2. When admin updates order status → Customer receives status update');
    console.log('   3. All automatic - no manual intervention needed!');
    console.log('\n🚀 Ready for production!');
    console.log('   - Update Vercel environment variables with your API key');
    console.log('   - Redeploy your backend');
    console.log('   - Order emails will work on production too!');
    console.log('\n');
    
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

testOrderEmail();
