const https = require('https');

console.log('Testing network connectivity to Resend API...\n');

// Test 1: Check if we can reach Resend API
const options = {
  hostname: 'api.resend.com',
  port: 443,
  path: '/emails',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.RESEND_API_KEY || 're_test'}`,
    'Content-Type': 'application/json'
  }
};

console.log('1. Testing HTTPS connection to api.resend.com...');

const req = https.request(options, (res) => {
  console.log(`   Status Code: ${res.statusCode}`);
  console.log(`   Status Message: ${res.statusMessage}`);
  
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log('\n2. Response from Resend:');
    try {
      const parsed = JSON.parse(data);
      console.log(JSON.stringify(parsed, null, 2));
      
      if (res.statusCode === 422) {
        console.log('\n✅ Network connection is working!');
        console.log('   (422 error is expected - we sent invalid data on purpose)');
        console.log('\n💡 This means your API key might be valid, but there\'s an issue with the request format.');
      } else if (res.statusCode === 401) {
        console.log('\n❌ API Key is invalid or unauthorized');
        console.log('   Please generate a new API key from Resend dashboard');
      } else if (res.statusCode === 200 || res.statusCode === 201) {
        console.log('\n✅ Everything is working!');
      }
    } catch (e) {
      console.log('   Raw response:', data);
    }
  });
});

req.on('error', (error) => {
  console.log('\n❌ Network Error:');
  console.log('   Error:', error.message);
  console.log('\n💡 Possible causes:');
  console.log('   - No internet connection');
  console.log('   - Firewall blocking the request');
  console.log('   - Proxy settings needed');
  console.log('   - VPN interfering with connection');
});

// Send a minimal test request
req.write(JSON.stringify({
  from: 'onboarding@resend.dev',
  to: ['test@example.com'],
  subject: 'Test',
  html: '<p>Test</p>'
}));

req.end();
