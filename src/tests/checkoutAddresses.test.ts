/**
 * Checkout addresses and the ICICI redirect: saved shipping / billing addresses are resolved by id from the caller's
 * own address book, stored as independent snapshots on the session and the order, and never change afterwards. ICICI
 * initiate only hands out a well-formed https payment page URL; a refused start reserves nothing and creates no order.
 * Needs a local MongoDB; uses (and drops) a throwaway database. ICICI is stubbed at fetch(): no network.
 * Run: npm test -- checkoutAddresses
 */
import assert from 'assert';
import { AddressInfo } from 'net';

const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_checkout_addresses_test';
const KEY = 'icici_test_key';
Object.assign(process.env, {
  NODE_ENV: 'development', HISTORY_READ_ENABLED: 'false', SENDGRID_API_KEY: '', FRONTEND_URL: 'https://shop.test',
  ICICI_PG_MERCHANT_ID: '100000000007164', ICICI_PG_SECRET_KEY: KEY, ICICI_PG_AGGREGATOR_ID: 'A100000000007164', ICICI_PG_CURRENCY_CODE: '356',
  ICICI_PG_INITIATE_SALE_URL: 'https://icici.test/initiateSale', ICICI_PG_COMMAND_URL: 'https://icici.test/command',
  ICICI_PG_RETURN_URL: 'https://api.shop.test/api/v1/payments/icici/callback',
});

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import { Product } from '../models/Product';
import Order from '../models/Order';
import { CheckoutSession } from '../models/CheckoutSession';
import { hashV1 } from '../utils/iciciPg';
import { paymentPageUrl } from '../controllers/iciciController';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`  ✅ ${name}`); };
const sign = (p: Record<string, any>) => ({ ...p, secureHash: hashV1(p, KEY) });

// ICICI stub: anything but the local server is answered here. `redirect` sets the next initiateSale redirectURI.
let initiateCalls = 0;
let redirect: string | null = 'https://icici.test/authRedirect';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
  const body = JSON.parse(init.body);
  initiateCalls++;
  const reply = sign({ responseCode: 'R1000', merchantId: body.merchantId, merchantTxnNo: body.merchantTxnNo, showOTPCapturePage: 'N',
    tranCtx: `R-${body.merchantTxnNo}`, ...(redirect === null ? {} : { redirectURI: redirect }) });
  return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const run = async () => {
  console.log('Payment page URL');
  await test('only a parseable https redirectURI with a tranCtx becomes a redirect; its own query is kept', () => {
    assert.strictEqual(paymentPageUrl({ redirectURI: 'https://pg.test/auth', tranCtx: 'AB12' }), 'https://pg.test/auth?tranCtx=AB12');
    assert.strictEqual(paymentPageUrl({ redirectURI: 'https://pg.test/auth?v=2', tranCtx: 'a b&c' }), 'https://pg.test/auth?v=2&tranCtx=a+b%26c');
    for (const bad of [{ redirectURI: 'http://pg.test/auth', tranCtx: 'x' }, { redirectURI: 'javascript:alert(1)', tranCtx: 'x' },
      { redirectURI: 'not a url', tranCtx: 'x' }, { redirectURI: 'https://pg.test/auth' }, { tranCtx: 'x' }, null, undefined]) {
      assert.strictEqual(paymentPageUrl(bad), '', JSON.stringify(bad));
    }
  });

  assert.ok(TEST_DB.endsWith('_test'));
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([Order.init(), CheckoutSession.init(), User.init()]);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };

  try {
    const home = { street: '1 MG Road', city: 'Kochi', state: 'Kerala', zipCode: '682001', country: 'India' };
    const office = { street: '9 Marine Drive', city: 'Mumbai', state: 'Maharashtra', zipCode: '400002', country: 'India' };
    const partial = { street: 'No PIN', city: 'Delhi', state: 'Delhi' };
    const mk = (name: string, addresses: object[]) => User.create({ name, email: `${name.toLowerCase()}@test.local`, password: 'Passw0rd#123', role: 'customer', isVerified: true, addresses });
    const [ann, ben] = await Promise.all([mk('Ann', [home, office, partial]), mk('Ben', [office])]);
    const tok = (u: any) => jwt.sign({ id: String(u._id), role: u.role }, ENV.JWT_SECRET, { expiresIn: '30m' });
    const [annT, benT] = [ann, ben].map(tok);
    const [homeId, officeId, partialId] = ann.addresses!.map((a: any) => String(a._id));
    const benOfficeId = String(ben.addresses![0]._id);

    const tea = await Product.create({ name: 'Tea', category: 'Snacks', description: 'Tea', variants: [{ volume: '200g', price: 300, offerPrice: 300, actualPrice: 300, stock: 10, weight: 0.2 }], stock: 10 });
    const items = [{ product: String(tea._id), variantId: String(tea.variants[0]._id), quantity: 1 }];
    const stock = async () => (await Product.findById(tea._id).lean())!.variants[0].stock;
    const totalFor = async (address: object) => (await call('POST', '/payments/calculate-shipping', { items, shippingAddress: address, fulfillment: { method: 'delivery' } })).json.data.grandTotal;
    const [homeTotal, officeTotal] = [await totalFor(home), await totalFor(office)];
    // Exactly what checkout/page.tsx sends: the selected card's fields plus its id, and the billing choice
    const initiate = (extra: Record<string, unknown>, token = annT, address: object = home, total = homeTotal) =>
      call('POST', '/payments/icici/initiate', { items, shippingAddress: address, fulfillment: { method: 'delivery' }, total, ...extra }, token);
    const sessionOf = async (r: any) => (await CheckoutSession.findOne({ razorpayOrderId: r.json.data.merchantTxnNo }).lean()) as any;
    const strip = (a: any) => ({ street: a.street, city: a.city, state: a.state, zipCode: a.zipCode, country: a.country });

    console.log('Billing and shipping snapshots');
    await test('same as delivery (no billingAddressId): billing is an equal, separate copy of the server-resolved shipping address', async () => {
      const r = await initiate({ shippingAddressId: homeId });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.match(r.json.data.redirectUrl, /^https:\/\/icici\.test\/authRedirect\?tranCtx=R-/);
      const s = await sessionOf(r);
      assert.deepStrictEqual([s.shippingAddress, s.billingAddress], [home, home]);
    });
    await test('a saved billing address different from delivery: stored independently', async () => {
      const r = await initiate({ shippingAddressId: homeId, billingAddressId: officeId });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const s = await sessionOf(r);
      assert.deepStrictEqual([s.shippingAddress, s.billingAddress], [home, office]);
    });
    await test('the shipping id wins over edited body fields: the server uses the saved address it priced for', async () => {
      const r = await initiate({ shippingAddressId: officeId }, annT, { ...office, street: 'Tampered' }, officeTotal);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual((await sessionOf(r)).shippingAddress, office);
    });
    await test('older clients (address fields only, no ids) still work; billing = shipping', async () => {
      const r = await initiate({});
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const s = await sessionOf(r);
      assert.deepStrictEqual([s.shippingAddress, s.billingAddress], [home, home]);
    });

    console.log('Delivery price follows the saved address the id resolves to');
    const delhi = { street: '5 Janpath', city: 'New Delhi', state: 'Delhi', zipCode: '110001', country: 'India' };
    // Make the zones cost different amounts (the defaults charge both the same, which would hide a mismatch)
    const boss = await User.create({ name: 'Boss', email: 'boss@test.local', password: 'Passw0rd#123', role: 'superadmin', isVerified: true });
    const bossT = tok(boss);
    const ship = (await call('GET', '/settings/checkout', undefined, bossT)).json.data.settings.shipping;
    const outside = ship.zones.outsideKerala;
    const setShip = await call('PUT', '/settings/checkout/shipping', { ...ship, zones: { ...ship.zones,
      outsideKerala: { ...outside, enabled: true, land: { ...outside.land, enabled: true, chargeBelow: 160, chargeAtOrAbove: 160 } } } }, bossT);
    assert.strictEqual(setShip.status, 200, JSON.stringify(setShip.json));
    assert.strictEqual(await totalFor(home), homeTotal, 'the Kerala rate is unchanged');
    const delhiId = (await call('POST', '/users/addresses', delhi, annT)).json.data.at(-1)._id;
    const delhiTotal = await totalFor(delhi);
    assert.ok(delhiTotal > homeTotal, `outside-Kerala delivery must cost more here (${delhiTotal} vs ${homeTotal})`);
    await test('body says Kerala, id says Delhi, Kerala total: refused (never charged the Kerala rate for a Delhi delivery)', async () => {
      const [sessions, calls] = [await CheckoutSession.countDocuments(), initiateCalls];
      const r = await initiate({ shippingAddressId: delhiId }, annT, home, homeTotal);
      assert.strictEqual(r.status, 400, JSON.stringify(r.json));
      assert.match(r.json.message, /Order total validation failed/);
      assert.deepStrictEqual([await CheckoutSession.countDocuments(), initiateCalls], [sessions, calls], 'no session, no gateway call');
    });
    await test('body says Kerala, id says Delhi, Delhi total: priced outside Kerala, ships to Delhi, still unpaid', async () => {
      const r = await initiate({ shippingAddressId: delhiId }, annT, home, delhiTotal);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const s = await sessionOf(r);
      assert.deepStrictEqual([s.shippingZone, s.amountPaise, s.shippingAddress, s.status], ['outsideKerala', Math.round(delhiTotal * 100), delhi, 'pending']);
      assert.strictEqual(await Order.countDocuments({ checkoutSession: s._id }), 0, 'no order before ICICI confirms the payment');
    });
    await test('a genuine Kerala checkout by id is still priced inside Kerala', async () => {
      const r = await initiate({ shippingAddressId: homeId }, annT, home, homeTotal);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const s = await sessionOf(r);
      assert.deepStrictEqual([s.shippingZone, s.amountPaise, s.shippingAddress], ['kerala', Math.round(homeTotal * 100), home]);
    });

    console.log('Refused address choices: 400, nothing reserved, no gateway call');
    const refused = async (extra: Record<string, unknown>, message: RegExp) => {
      const [calls, sessions] = [initiateCalls, await CheckoutSession.countDocuments()];
      const r = await initiate(extra);
      assert.strictEqual(r.status, 400, JSON.stringify(r.json));
      assert.match(r.json.message, message);
      // Full stock: Ann's earlier unpaid holds are released by any new start (existing behaviour) and this one took none
      assert.deepStrictEqual([await stock(), initiateCalls, await CheckoutSession.countDocuments()], [10, calls, sessions]);
    };
    await test('billing id: malformed, unknown or another customer\'s', async () => {
      for (const id of ['not-an-id', '0'.repeat(24), benOfficeId, 42]) await refused({ shippingAddressId: homeId, billingAddressId: id }, /billing address no longer exists/);
    });
    await test('billing address missing its PIN code', async () => {
      await refused({ shippingAddressId: homeId, billingAddressId: partialId }, /billing address is missing/);
    });
    await test('shipping id of another customer, or of an address deleted since the page loaded', async () => {
      await refused({ shippingAddressId: benOfficeId }, /delivery address no longer exists/);
      const doomed = (await call('POST', '/users/addresses', { ...office, street: 'Old flat' }, annT)).json.data.at(-1)._id;
      assert.strictEqual((await call('DELETE', `/users/addresses/${doomed}`, undefined, annT)).status, 200);
      await refused({ shippingAddressId: doomed }, /delivery address no longer exists/);
      await refused({ shippingAddressId: homeId, billingAddressId: doomed }, /billing address no longer exists/);
    });

    console.log('ICICI redirect refused');
    for (const [label, uri] of [['plain-http redirectURI', 'http://icici.test/authRedirect'], ['no redirectURI', null]] as const) {
      await test(`${label}: 502, the session is released (stock back), no order`, async () => {
        redirect = uri;
        const before = await stock();
        const r = await initiate({ shippingAddressId: homeId });
        redirect = 'https://icici.test/authRedirect';
        assert.deepStrictEqual([r.status, r.json.message], [502, 'The ICICI payment gateway could not start this payment. You have not been charged. Please try again.']);
        assert.strictEqual(r.json.data, undefined, 'no redirect URL handed out');
        assert.strictEqual(await stock(), before);
        assert.strictEqual(await Order.countDocuments(), 0);
      });
    }

    console.log('Order snapshot');
    await test('a paid order stores both snapshots; later address-book edits and deletes never change them', async () => {
      const r = await initiate({ shippingAddressId: homeId, billingAddressId: officeId });
      const txnNo = r.json.data.merchantTxnNo;
      const back = await fetch(`${base}/payments/icici/callback`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(sign({ responseCode: '0000', merchantId: '100000000007164', merchantTxnNo: txnNo, txnID: `T${txnNo}`, amount: homeTotal.toFixed(2) })) });
      assert.strictEqual(back.headers.get('location'), 'https://shop.test/order-success');
      const order = (await Order.findOne({ user: ann._id }).lean())!;
      assert.deepStrictEqual([strip(order.shippingAddress), strip(order.billingAddress)], [home, office]);
      await call('PUT', `/users/addresses/${officeId}`, { ...office, city: 'Pune' }, annT);
      await call('DELETE', `/users/addresses/${homeId}`, undefined, annT);
      const again = (await Order.findById(order._id).lean())!;
      assert.deepStrictEqual([strip(again.shippingAddress), strip(again.billingAddress)], [home, office]);
      const mine = (await call('GET', '/payments/myorders', undefined, annT)).json.data;
      assert.deepStrictEqual(strip(mine[0].billingAddress), office, 'the customer sees the billing snapshot');
    });
    await test('another customer is unaffected throughout', async () => {
      assert.deepStrictEqual((await call('GET', '/users/addresses', undefined, benT)).json.data.map((a: any) => a._id), [benOfficeId]);
    });

    console.log(`\n${passed} passed`);
  } finally {
    server.close();
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  }
};

run().then(() => process.exit(0), (err) => { console.error('❌', err); process.exit(1); });
