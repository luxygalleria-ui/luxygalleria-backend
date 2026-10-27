/** Fulfilment statuses of an order. Payment status is separate (Order.paymentStatus) and never changed by these rules. */
export const ORDER_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'] as const;

const RANK: Record<string, number> = { processing: 0, shipped: 1, delivered: 2 };

/**
 * Forward only; cancel allowed until delivered; delivered and cancelled are final.
 * The one rule for both the ERP status callback and the admin status change.
 */
export const canMoveOrderStatus = (from: string, to: string) =>
  to === 'cancelled' ? from === 'processing' || from === 'shipped' : from !== 'cancelled' && RANK[to] > RANK[from];
