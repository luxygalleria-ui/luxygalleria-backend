# ⚡ Quick Start - Fix Order Emails in 3 Steps

## Your order confirmation emails aren't working because your Resend API key is invalid.

---

## Step 1: Get New API Key (2 minutes)

1. Go to: **https://resend.com/login**
2. Log in or sign up (free)
3. Click **"API Keys"** → **"Create API Key"**
4. Name it: `Heedy Backend`
5. Copy the key (starts with `re_`)

---

## Step 2: Update .env File (30 seconds)

Open this file: `d:\SDEC\heedi\Heedy-backend\.env`

Find this line:
```env
RESEND_API_KEY=re_3Pgagz27_B6VksR7k68xb8xgRyF2d5EUS
```

Replace with your new key:
```env
RESEND_API_KEY=re_your_new_key_here
```

**Example:**
```env
RESEND_API_KEY=re_abc123def456ghi789jkl012mno345pqr
```

Save the file.

---

## Step 3: Test It (30 seconds)

Open terminal and run:
```bash
cd d:\SDEC\heedi\Heedy-backend
node test-resend.js
```

**Success looks like:**
```
✅ Test email sent successfully via Resend!
Email ID: 12345678-1234-1234-1234-123456789012
📧 Check your inbox at: muhammedminhaj798@gmail.com
```

**Check your email!** You should receive a test email.

---

## ✅ Done! Your Order Emails Will Now Work!

When customers place orders, they'll automatically receive:
- ✉️ Order confirmation email
- ✉️ Order status update emails

---

## 🚀 Deploy to Vercel (Production)

1. Go to **Vercel Dashboard**
2. Select your backend project
3. **Settings** → **Environment Variables**
4. Update `RESEND_API_KEY` with your new key
5. Click **Redeploy**

---

## 📧 What Emails Are Sent?

### 1. Order Confirmation (Automatic)
**Trigger:** Customer completes payment
**File:** `src/controllers/paymentController.ts` → `verifyPayment()`
**Contains:**
- Order ID
- Order date
- Total amount
- Link to view order

### 2. Order Status Update (Automatic)
**Trigger:** Admin changes order status
**File:** `src/controllers/paymentController.ts` → `updateOrderStatus()`
**Contains:**
- Order ID
- New status (Processing, Shipped, Delivered, Cancelled)
- Color-coded status badge
- Link to order history

---

## 🆓 Resend Free Tier

- 3,000 emails/month
- 100 emails/day
- More than enough for most stores!

---

## ❓ Troubleshooting

### Test email not received?
1. Check spam folder
2. Verify API key is correct (no spaces)
3. Check Resend Dashboard → **Emails** for logs

### Still not working?
1. Make sure you saved the .env file
2. Restart your backend server
3. Check backend logs for errors

---

**Need the full guide?** Read `GET_RESEND_API_KEY.md`
