/**
 * Order emails link to <storefront>/profile exactly once-slashed, whatever FRONTEND_URL ends with (production's ends
 * with "/", which produced https://luxygalleria.com//profile). Mail goes to an in-memory mock; nothing is sent.
 * No database needed. Run: npx ts-node --transpile-only src/tests/orderEmailLinks.test.ts
 */
import assert from 'assert';

Object.assign(process.env, { NODE_ENV: 'production', HISTORY_READ_ENABLED: 'false', SENDGRID_API_KEY: '' });

import * as mail from '../utils/sendEmail';
import { sendOrderConfirmationEmail, sendOrderStatusEmail } from '../controllers/paymentController';

const outbox: { email: string; subject: string; html?: string }[] = [];
(mail as any).sendEmail = async (o: any) => { outbox.push(o); return { success: true, provider: 'mock' }; };

const user = { _id: 'u1', name: 'Ann', email: 'ann@test.local', role: 'customer' };
const order = {
  _id: '6b0000000000000000000001', createdAt: new Date('2026-11-23T10:00:00Z'), user,
  items: [{ product: { name: 'RedBull' }, name: 'RedBull', quantity: 2, price: 99, subtotal: 198 }],
  subtotal: 198, shippingFee: 80, total: 278, discount: 0, tax: { enabled: false },
  fulfillmentMethod: 'delivery', shippingMethod: 'land', paymentMethod: 'icici', paymentStatus: 'completed', orderStatus: 'processing',
  shippingAddress: { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' },
};

const run = async () => {
  let checks = 0;
  for (const base of ['https://shop.test/', 'https://shop.test', 'https://shop.test///']) {
    process.env.FRONTEND_URL = base;
    outbox.length = 0;
    await sendOrderConfirmationEmail(order, user);
    await sendOrderStatusEmail(order, 'shipped');
    assert.strictEqual(outbox.length, 2, `both emails built (FRONTEND_URL=${base})`);
    for (const m of outbox) {
      assert.ok(m.html!.includes('href="https://shop.test/profile"'), `${m.subject}: link is https://shop.test/profile (FRONTEND_URL=${base})`);
      assert.ok(!/https:\/\/shop\.test\/\/+profile/.test(m.html!), `${m.subject}: no double slash`);
      checks += 2;
    }
  }
  delete process.env.FRONTEND_URL; // unset: the local default, still single-slashed
  outbox.length = 0;
  await sendOrderConfirmationEmail(order, user);
  assert.ok(outbox[0].html!.includes('href="http://localhost:3000/profile"')); checks++;

  // ICICI UAT test orders: every email says so in the subject and the body; real orders are unchanged
  const NOTICE = 'UAT TEST PAYMENT — NO REAL MONEY WAS RECEIVED. THIS ORDER WILL NOT BE DELIVERED.';
  for (const testPayment of [true, false]) {
    outbox.length = 0;
    const o = { ...order, testPayment };
    await sendOrderConfirmationEmail(o, user);
    await sendOrderStatusEmail(o, 'cancelled');
    assert.strictEqual(outbox.length, 2);
    for (const m of outbox) {
      assert.strictEqual(m.subject.startsWith('[UAT TEST - NOT A REAL ORDER] '), testPayment, `${m.subject}: subject tag`);
      assert.strictEqual(m.html!.includes(NOTICE), testPayment, `${m.subject}: body notice`);
      checks += 2;
    }
  }
  console.log(`✅ order email links: one slash before /profile for every FRONTEND_URL form; UAT test orders tagged (${checks} checks)`);
};

run().catch((e) => { console.error('❌', e); process.exit(1); });
