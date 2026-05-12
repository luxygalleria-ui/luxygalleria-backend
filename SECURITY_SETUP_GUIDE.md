# 🔒 Security Setup Guide - Quick Start

## ⚡ Quick Setup (15 minutes)

Follow these steps in order to secure your backend.

---

## Step 1: Install Security Packages (2 minutes)

```bash
cd d:\SDEC\heedi\Heedy-backend
npm install express-rate-limit express-mongo-sanitize winston
```

**Verify installation:**
```bash
npm list express-rate-limit express-mongo-sanitize winston
```

---

## Step 2: Create Logs Directory (30 seconds)

```bash
mkdir logs
echo logs/ >> .gitignore
```

---

## Step 3: Generate New JWT Secret (1 minute)

**Run this command:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Copy the output and update `.env`:**
```env
JWT_SECRET=<paste_the_64_character_string_here>
```

---

## Step 4: Protect .env File (1 minute)

**Check if .env is in .gitignore:**
```bash
type .gitignore | findstr .env
```

**If not found, add it:**
```bash
echo .env >> .gitignore
echo .env.local >> .gitignore
echo .env.*.local >> .gitignore
```

**Remove from git (if already committed):**
```bash
git rm --cached .env
git commit -m "chore: remove .env from repository"
```

---

## Step 5: Test the Server (2 minutes)

**Start the server:**
```bash
npm run dev
```

**Check for errors:**
- ✅ Server should start without errors
- ✅ Check console for "Server running on port 5000"
- ✅ No module not found errors

**If you see errors:**
- Make sure all packages are installed
- Check that logs directory exists
- Verify .env file is present

---

## Step 6: Test Security Features (5 minutes)

### Test 1: Rate Limiting
Open Postman or use curl:

```bash
# Try to login 6 times quickly (should block after 5)
curl -X POST http://localhost:5000/api/v1/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"test@test.com\",\"password\":\"wrong\"}"
```

**Expected:** After 5 attempts, you should see:
```json
{
  "success": false,
  "message": "Too many login attempts from this IP, please try again after 15 minutes."
}
```

### Test 2: Input Validation
```bash
# Try to register with weak password
curl -X POST http://localhost:5000/api/v1/auth/register ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"test@test.com\",\"password\":\"weak\",\"name\":\"Test\"}"
```

**Expected:** Validation error about password requirements

### Test 3: NoSQL Injection Protection
```bash
# Try NoSQL injection
curl -X POST http://localhost:5000/api/v1/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":{\"$gt\":\"\"},\"password\":\"test\"}"
```

**Expected:** Should be sanitized and fail normally (not bypass authentication)

---

## Step 7: Update Routes with Validation (5 minutes)

### Update authRoutes.ts:

**File:** `src/routes/authRoutes.ts`

```typescript
import { Router } from 'express';
import { 
  loginAdmin, 
  createTestAdmin, 
  registerCustomer, 
  loginCustomer, 
  verifyOtp, 
  resendOtp, 
  googleAuth 
} from '../controllers/authController';
import { validate, schemas } from '../middlewares/validation';
import { authLimiter, otpLimiter } from '../middlewares/rateLimiter';
import { ENV } from '../config/env';

const router = Router();

// Admin routes
router.post('/login', authLimiter, validate(schemas.login), loginAdmin);

// Customer routes
router.post('/customer-login', authLimiter, validate(schemas.login), loginCustomer);
router.post('/register', authLimiter, validate(schemas.register), registerCustomer);
router.post('/verify-otp', otpLimiter, validate(schemas.verifyOtp), verifyOtp);
router.post('/resend-otp', otpLimiter, resendOtp);
router.post('/google', authLimiter, googleAuth);

// Test admin - only in development
if (ENV.NODE_ENV === 'development') {
  router.post('/setup-test-admin', createTestAdmin);
}

export default router;
```

---

### Update productRoutes.ts:

**File:** `src/routes/productRoutes.ts`

```typescript
import express from 'express';
import { createProduct, getProducts, deleteProduct, updateProduct } from '../controllers/productController';
import { protect, authorize } from '../middlewares/authMiddleware';
import { upload } from '../middlewares/uploadMiddleware';
import { uploadLimiter } from '../middlewares/rateLimiter';
import { validate, schemas } from '../middlewares/validation';

const router = express.Router();

router.route('/')
  .post(
    protect, 
    authorize('admin', 'superadmin'), 
    uploadLimiter,
    upload.array('imageFiles', 5), 
    validate(schemas.createProduct),
    createProduct
  )
  .get(getProducts);

router.route('/:id')
  .put(
    protect, 
    authorize('admin', 'superadmin'),
    uploadLimiter,
    upload.array('imageFiles', 5), 
    validate(schemas.updateProduct),
    updateProduct
  )
  .delete(
    protect, 
    authorize('admin', 'superadmin'),
    validate(schemas.mongoId),
    deleteProduct
  );

export default router;
```

---

### Update paymentRoutes.ts:

**File:** `src/routes/paymentRoutes.ts`

```typescript
import express from 'express';
import { 
  createOrder, 
  verifyPayment, 
  getMyOrders, 
  getAllOrders, 
  updateOrderStatus 
} from '../controllers/paymentController';
import { protect, authorize } from '../middlewares/authMiddleware';
import { paymentLimiter } from '../middlewares/rateLimiter';
import { validate, schemas } from '../middlewares/validation';

const router = express.Router();

router.post('/create-order', protect, paymentLimiter, validate(schemas.createOrder), createOrder);
router.post('/verify', protect, paymentLimiter, validate(schemas.verifyPayment), verifyPayment);
router.get('/myorders', protect, getMyOrders);
router.get('/orders', protect, authorize('admin', 'superadmin'), getAllOrders);
router.put('/orders/:id', protect, authorize('admin', 'superadmin'), validate(schemas.mongoId), updateOrderStatus);

export default router;
```

---

### Update userRoutes.ts:

**File:** `src/routes/userRoutes.ts`

```typescript
import express from 'express';
import {
  getAddresses,
  updateProfile,
  addAddress,
  deleteAddress,
  editAddress,
  getAllCustomers,
  toggleCustomerStatus,
} from '../controllers/userController';
import { protect, authorize } from '../middlewares/authMiddleware';
import { validate, schemas } from '../middlewares/validation';

const router = express.Router();

// Customer routes
router.get('/addresses', protect, getAddresses);
router.put('/profile', protect, validate(schemas.updateProfile), updateProfile);
router.post('/addresses', protect, validate(schemas.addAddress), addAddress);
router.delete('/addresses/:addressId', protect, deleteAddress);
router.put('/addresses/:addressId', protect, validate(schemas.addAddress), editAddress);

// Admin routes
router.get('/customers', protect, authorize('admin', 'superadmin'), getAllCustomers);
router.patch('/customers/:id/toggle-status', protect, authorize('admin', 'superadmin'), validate(schemas.mongoId), toggleCustomerStatus);

export default router;
```

---

## Step 8: Restart and Test (2 minutes)

**Restart the server:**
```bash
# Stop the server (Ctrl+C)
# Start again
npm run dev
```

**Test an endpoint:**
```bash
curl http://localhost:5000/api/v1/products
```

**Expected:** Should work normally

---

## ✅ Verification Checklist

After completing all steps, verify:

- [ ] All packages installed successfully
- [ ] Server starts without errors
- [ ] Logs directory exists
- [ ] .env is in .gitignore
- [ ] JWT_SECRET is updated (64 characters)
- [ ] Rate limiting works (test with multiple requests)
- [ ] Input validation works (test with invalid data)
- [ ] Authorization works (customers can't access admin routes)
- [ ] No console errors in terminal

---

## 🚨 Common Issues

### Issue: "Cannot find module 'express-rate-limit'"
**Solution:**
```bash
npm install express-rate-limit express-mongo-sanitize winston
```

### Issue: "ENOENT: no such file or directory, open 'logs/error.log'"
**Solution:**
```bash
mkdir logs
```

### Issue: "Validation failed"
**Solution:** Check that you're sending the correct data format. Example:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "SecurePass123!"
}
```

### Issue: Rate limit not working
**Solution:** Clear your browser cache or use incognito mode. Rate limits are per IP address.

---

## 📊 Security Status After Setup

| Feature | Status |
|---------|--------|
| Rate Limiting | ✅ Active |
| Input Validation | ✅ Active |
| NoSQL Injection Protection | ✅ Active |
| XSS Protection | ✅ Active |
| Security Logging | ✅ Active |
| Authorization | ✅ Active |
| Body Size Limits | ✅ Active |
| Helmet Security Headers | ✅ Active |
| CORS Protection | ✅ Active |

---

## 🎯 What's Next?

After completing this setup, you should:

1. **Deploy to AWS** with updated environment variables
2. **Monitor logs** in the `logs/` directory
3. **Review** `SECURITY_AUDIT_REPORT.md` for remaining issues
4. **Implement** account lockout (see SECURITY_FIXES_APPLIED.md)
5. **Rotate** all other credentials (MongoDB, Cloudinary, Razorpay)

---

## 📞 Need Help?

If you encounter issues:
1. Check the console for error messages
2. Review `SECURITY_AUDIT_REPORT.md`
3. Check `SECURITY_FIXES_APPLIED.md` for detailed fixes
4. Verify all packages are installed: `npm list`

---

**Setup Time:** ~15 minutes
**Security Level:** 🟢 Good (was 🔴 Critical)
**Remaining Issues:** 12 (see SECURITY_FIXES_APPLIED.md)
