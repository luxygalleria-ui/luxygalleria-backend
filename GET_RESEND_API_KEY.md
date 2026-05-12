# 🔑 How to Get Your Resend API Key

## Your current API key is invalid or expired. Follow these steps:

### Step 1: Go to Resend
Visit: **https://resend.com/login**

### Step 2: Sign Up or Log In
- If you don't have an account, sign up (it's free!)
- If you have an account, log in

### Step 3: Create API Key
1. After logging in, click on **"API Keys"** in the left sidebar
2. Click the **"Create API Key"** button
3. Give it a name: `Heedy Backend Production`
4. Select permissions: **"Full Access"** or **"Sending Access"**
5. Click **"Create"**

### Step 4: Copy Your API Key
- You'll see a key that starts with `re_`
- Example: `re_123abc456def789ghi012jkl345mno678`
- **IMPORTANT:** Copy it now! You won't be able to see it again.

### Step 5: Update Your .env File
Open `d:\SDEC\heedi\Heedy-backend\.env` and replace this line:

**Current (Invalid):**
```env
RESEND_API_KEY=re_3Pgagz27_B6VksR7k68xb8xgRyF2d5EUS
```

**Replace with your new key:**
```env
RESEND_API_KEY=re_your_new_api_key_here
```

### Step 6: Test It
Run this command in your terminal:
```bash
cd d:\SDEC\heedi\Heedy-backend
node test-resend.js
```

You should see:
```
✅ Test email sent successfully via Resend!
Email ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
📧 Check your inbox at: muhammedminhaj798@gmail.com
```

### Step 7: Update Vercel (For Production)
1. Go to **Vercel Dashboard**: https://vercel.com
2. Select your **Heedy-backend** project
3. Go to **Settings** → **Environment Variables**
4. Find `RESEND_API_KEY` and click **Edit**
5. Paste your new API key
6. Click **Save**
7. **Redeploy** your backend

---

## ✅ Your Code is Already Set Up!

I've already integrated Resend into your project:

### File: `src/utils/sendEmail.ts`
```typescript
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendEmail = async (options: { 
  email: string; 
  subject: string; 
  message?: string; 
  html?: string 
}) => {
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const fromName = process.env.FROM_NAME || 'Heedy';

  const { data, error } = await resend.emails.send({
    from: `${fromName} <${fromEmail}>`,
    to: [options.email],
    subject: options.subject,
    html: options.html || options.message
  });

  if (error) {
    throw new Error(`Failed to send email: ${error.message}`);
  }

  return data;
};
```

### Your Order Emails Will Work Automatically!

Once you update the API key, these emails will be sent automatically:

1. **Order Confirmation Email** - When customer places an order
2. **Order Status Update Email** - When admin changes order status

No additional code changes needed! 🎉

---

## 🆓 Resend Free Tier

- **3,000 emails per month**
- **100 emails per day**
- Perfect for your e-commerce store!

---

## ❓ Need Help?

If you have any issues:
1. Make sure you copied the entire API key (starts with `re_`)
2. Check there are no extra spaces in the .env file
3. Restart your backend server after updating .env
4. Check Resend Dashboard → **Emails** for delivery logs

**Resend Support:** https://resend.com/docs
