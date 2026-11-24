/** Fulfilment statuses of an order. Payment status is separate (Order.paymentStatus) and never changed by these rules. */
export const ORDER_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'] as const;

const RANK: Record<string, number> = { processing: 0, shipped: 1, delivered: 2 };

/**
 * Forward only; cancel allowed until delivered; delivered and cancelled are final.
 * The one rule for both the ERP status callback and the admin status change.
 */
/**
 * An ICICI UAT test order (testPayment) received no money: it may never become shipped or delivered, through any path
 * (admin status change, superadmin correction, ERP webhook). testPayment is set once at creation and never changed.
 */
export const TEST_ORDER_NOT_SHIPPABLE = {
  code: 'TEST_PAYMENT_NOT_SHIPPABLE',
  message: 'UAT test order: no money was received, so it cannot be shipped or delivered',
} as const;
export const shipBlocked = (order: { testPayment?: boolean } | null | undefined, to: string) =>
  order?.testPayment === true && (to === 'shipped' || to === 'delivered');
/** Extra update filter for the same rule, so even a racing write cannot ship a test order. */
export const notShippableTestFilter = (to: string) => (to === 'shipped' || to === 'delivered' ? { testPayment: { $ne: true } } : {});

export const canMoveOrderStatus = (from: string, to: string) =>
  to === 'cancelled' ? from === 'processing' || from === 'shipped' : from !== 'cancelled' && RANK[to] > RANK[from];
