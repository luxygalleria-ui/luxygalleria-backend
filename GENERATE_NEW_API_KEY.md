# 🔑 Generate a NEW Resend API Key

## ⚠️ Your Current API Key is Invalid

The API key `re_3Pgagz2...` in your `.env` file is **expired or invalid**.

You need to generate a **brand new** API key from Resend.

---

## 📋 Step-by-Step Instructions

### Step 1: Go to Resend Dashboard
Open your browser and go to:
```
https://resend.com/api-keys
```

Or:
1. Go to https://resend.com/login
2. Log in with your account
3. Click **"API Keys"** in the left sidebar

---

### Step 2: Create New API Key

1. Click the **"Create API Key"** button (usually blue button on the right)

2. Fill in the form:
   - **Name**: `Heedy Backend Production`
   - **Permission**: Select **"Sending access"** or **"Full access"**
   - **Domain**: Leave as default or select your domain

3. Click **"Add"** or **"Create"**

---

### Step 3: Copy Your New API Key

⚠️ **IMPORTANT**: You can only see the API key ONCE!

1. After creating, you'll see a key that looks like:
   ```
   re_AbCdEfGh123456789IjKlMnOp
   ```

2. Click the **"Copy"** button or manually select and copy the entire key

3. Make sure you copy the **ENTIRE** key (usually 36-40 characters)

---

### Step 4: Update Your .env File

1. Open: `d:\SDEC\heedi\Heedy-backend\.env`

2. Find line 18:
   ```env
   RESEND_API_KEY=re_3Pgagz27_B6VksR7k68xb8xgRyF2d5EUS
   ```

3. Replace with your NEW key:
   ```env
   RESEND_API_KEY=re_your_new_key_here
   ```

4. **Save the file** (Ctrl+S)

---

### Step 5: Test the New Key

Open terminal and run:
```bash
cd d:\SDEC\heedi\Heedy-backend
node test-resend-detailed.js
```

**Success looks like:**
```
✅ SUCCESS! Email sent successfully!
Email ID: 12345678-1234-1234-1234-123456789012
📧 Check your inbox! You should receive the test email shortly.
🎉 Your order confirmation emails will now work!
```

**Check your email:** muhammedminhaj798@gmail.com

---

### Step 6: Update Vercel (For Production)

Once the test works locally:

1. Go to **Vercel Dashboard**: https://vercel.com
2. Select your **Heedy-backend** project
3. Go to **Settings** → **Environment Variables**
4. Find `RESEND_API_KEY`
5. Click **Edit** (pencil icon)
6. Paste your new API key
7. Click **Save**
8. Go to **Deployments** tab
9. Click **"Redeploy"** on the latest deployment

---

## 🎯 Why You Need a New Key

Your current key might be invalid because:
- ❌ It was generated for testing and expired
- ❌ It was deleted from Resend dashboard
- ❌ It doesn't have the right permissions
- ❌ It's from a different Resend account

**Solution:** Generate a fresh new key with full permissions.

---

## ✅ After This Works

Once you see the success message, your order emails will work automatically:

1. **Order Confirmation Email** - Sent when customer completes payment
2. **Order Status Update Email** - Sent when admin changes order status

No additional code changes needed!

---

## 🆘 Still Having Issues?

### Issue: Can't log in to Resend
- Create a new account at https://resend.com/signup
- It's free! (3,000 emails/month)

### Issue: Don't see "Create API Key" button
- Make sure you're logged in
- Check you're on the API Keys page
- Try refreshing the page

### Issue: Test still fails after updating key
- Make sure you saved the .env file
- Check there are no extra spaces before/after the key
- Make sure you copied the ENTIRE key
- Try restarting your terminal

### Issue: Email not received
- Check spam folder
- Wait 1-2 minutes (sometimes delayed)
- Check Resend Dashboard → **Emails** for delivery status

---

## 📞 Need Help?

- **Resend Documentation**: https://resend.com/docs
- **Resend Support**: support@resend.com
- **Resend Status**: https://status.resend.com

---

## 🎁 Resend Free Tier

- ✅ 3,000 emails per month
- ✅ 100 emails per day
- ✅ Perfect for e-commerce stores
- ✅ No credit card required

---

**🚀 Once you update the API key, your order emails will work perfectly!**
