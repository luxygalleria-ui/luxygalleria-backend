import Order from '../models/Order';
import { releaseStock } from './checkoutSessions';

/**
 * Runs after an order has moved to "cancelled" (admin status change or ERP event), with the status it came from.
 * - Cancelled before shipping (from "processing"): the units go back to stock, exactly once. The one-time
 *   stockRestoredAt claim is atomic, so a retried request or a racing ERP event can never restock twice.
 *   Shipped or delivered orders are never restocked automatically (the goods have left the store).
 * - A paid order (paymentStatus "completed") is flagged refund "required" unless a refund already exists, so it
 *   shows up for the superadmin refund action. Nothing is refunded automatically.
 */
export const afterOrderCancelled = async (orderId: unknown, previousStatus: string) => {
  if (previousStatus === 'processing') {
    const claimed = await Order.findOneAndUpdate(
      { _id: orderId, orderStatus: 'cancelled', stockRestoredAt: { $exists: false } },
      { $set: { stockRestoredAt: new Date() } },
      { new: true },
    ).lean();
    if (claimed) {
      await releaseStock((claimed.items || []).filter((i: any) => i.variantId)
        .map((i: any) => ({ product: i.product, variantId: i.variantId, quantity: i.quantity, name: i.name })));
    }
  }
  await Order.updateOne(
    // A UAT test order (testPayment) received no money: nothing to refund
    { _id: orderId, orderStatus: 'cancelled', paymentStatus: 'completed', testPayment: { $ne: true }, $or: [{ 'refund.status': { $exists: false } }, { 'refund.status': null }] },
    { $set: { 'refund.status': 'required' }, $push: { 'refund.events': { at: new Date(), by: 'system', action: 'required', detail: 'Paid order cancelled: refund the customer' } } },
  );
};
