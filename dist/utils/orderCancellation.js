"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.afterOrderCancelled = void 0;
const Order_1 = __importDefault(require("../models/Order"));
const checkoutSessions_1 = require("./checkoutSessions");
/**
 * Runs after an order has moved to "cancelled" (admin status change or ERP event), with the status it came from.
 * - Cancelled before shipping (from "processing"): the units go back to stock, exactly once. The one-time
 *   stockRestoredAt claim is atomic, so a retried request or a racing ERP event can never restock twice.
 *   Shipped or delivered orders are never restocked automatically (the goods have left the store).
 * - A paid order (paymentStatus "completed") is flagged refund "required" unless a refund already exists, so it
 *   shows up for the superadmin refund action. Nothing is refunded automatically.
 */
const afterOrderCancelled = async (orderId, previousStatus) => {
    if (previousStatus === 'processing') {
        const claimed = await Order_1.default.findOneAndUpdate({ _id: orderId, orderStatus: 'cancelled', stockRestoredAt: { $exists: false } }, { $set: { stockRestoredAt: new Date() } }, { new: true }).lean();
        if (claimed) {
            await (0, checkoutSessions_1.releaseStock)((claimed.items || []).filter((i) => i.variantId)
                .map((i) => ({ product: i.product, variantId: i.variantId, quantity: i.quantity, name: i.name })));
        }
    }
    await Order_1.default.updateOne({ _id: orderId, orderStatus: 'cancelled', paymentStatus: 'completed', $or: [{ 'refund.status': { $exists: false } }, { 'refund.status': null }] }, { $set: { 'refund.status': 'required' }, $push: { 'refund.events': { at: new Date(), by: 'system', action: 'required', detail: 'Paid order cancelled: refund the customer' } } });
};
exports.afterOrderCancelled = afterOrderCancelled;
//# sourceMappingURL=orderCancellation.js.map