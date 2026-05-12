# Resend Email Setup for Heedy Backend

## Why Resend Instead of Nodemailer?

Nodemailer doesn't work on Vercel serverless functions because:
- Vercel has timeout limits (10-60 seconds)
- SMTP connections can be slow and unreliable
- Serverless functions don't maintain persistent connections

**Resend** is perfect for Vercel because:
- ✅ Fast API-based email delivery
- ✅ Works perfectly with serverless functions
- ✅ Free tier: 100 emails/day, 3,000 emails/month
- ✅ Better deliverability than SMTP
- ✅ Email tracking and analytics

## Setup Instructions

### Step 1: Get Your Resend API Key

1. Go to [https://resend.com/](https://resend.com/)
2. Sign up or log in
3. Go to **API Keys** section
4. Click **Create API Key**
5. Give it a name like "Heedy Backend"
6. Copy the API key (starts with `re_`)

### Step 2: Update Your .env File

```env
RESEND_API_KEY=re_your_actual_api_key_here
RESEND_FROM_EMAIL=onboarding@resend.dev
FROM_NAME=Heedy
```

**Important Notes:**
- For testing, use `onboarding@resend.dev` as the from email
- For production, you need to verify your own domain in Resend
- The current key in .env might be expired or invalid

### Step 3: Verify Your Domain (For Production)

To send emails from your own domain (e.g., `orders@heedy.com`):

1. Go to Resend Dashboard → **Domains**
2. Click **Add Domain**
3. Enter your domain (e.g., `heedy.com`)
4. Add the DNS records Resend provides to your domain registrar
5. Wait for verification (usually 5-10 minutes)
6. Update `.env`:
   ```env
   RESEND_FROM_EMAIL=orders@heedy.com
   ```

### Step 4: Test the Configuration

Run the test script:
```bash
node test-resend.js
```

You should see:
```
✅ Test email sent successfully via Resend!
Email ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Step 5: Deploy to Vercel

1. Add environment variables in Vercel Dashboard:
   - Go to your project → Settings → Environment Variables
   - Add `RESEND_API_KEY`
   - Add `RESEND_FROM_EMAIL`
   - Add `FROM_NAME`

2. Redeploy your backend

## Code Changes Made

### ✅ Updated: `src/utils/sendEmail.ts`
- Replaced Nodemailer with Resend
- Uses Resend API for email delivery
- Works perfectly on Vercel serverless functions

### ✅ No Changes Needed:
- `src/controllers/paymentController.ts` - Already uses `sendEmail()` function
- Email templates remain the same
- All email sending logic stays the same

## Testing Order Emails

1. Place a test order from your frontend
2. Check the backend logs for:
   ```
   Email sent successfully via Resend: <email-id>
   ```
3. Check your email inbox
4. If email doesn't arrive, check Resend Dashboard → **Emails** for delivery status

## Troubleshooting

### Error: "Unable to fetch data"
- Your API key is invalid or expired
- Generate a new API key from Resend dashboard

### Error: "Invalid from address"
- Use `onboarding@resend.dev` for testing
- Or verify your own domain first

### Emails going to spam
- Verify your domain in Resend
- Add SPF, DKIM, and DMARC records
- Use a professional from address

### Rate limits
- Free tier: 100 emails/day
- Upgrade to paid plan if needed

## Resend Pricing

- **Free**: 3,000 emails/month, 100/day
- **Pro**: $20/month for 50,000 emails
- **Enterprise**: Custom pricing

For most e-commerce sites, the free tier is enough to start!

## Alternative Email Services for Vercel

If you don't want to use Resend, other good alternatives:

1. **SendGrid** - Popular, generous free tier
2. **Mailgun** - Good for transactional emails
3. **Postmark** - Excellent deliverability
4. **AWS SES** - Cheapest for high volume

All of these work with Vercel serverless functions!
