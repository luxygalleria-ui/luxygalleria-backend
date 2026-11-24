"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canMoveOrderStatus = exports.notShippableTestFilter = exports.shipBlocked = exports.TEST_ORDER_NOT_SHIPPABLE = exports.ORDER_STATUSES = void 0;
/** Fulfilment statuses of an order. Payment status is separate (Order.paymentStatus) and never changed by these rules. */
exports.ORDER_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'];
const RANK = { processing: 0, shipped: 1, delivered: 2 };
/**
 * Forward only; cancel allowed until delivered; delivered and cancelled are final.
 * The one rule for both the ERP status callback and the admin status change.
 */
/**
 * An ICICI UAT test order (testPayment) received no money: it may never become shipped or delivered, through any path
 * (admin status change, superadmin correction, ERP webhook). testPayment is set once at creation and never changed.
 */
exports.TEST_ORDER_NOT_SHIPPABLE = {
    code: 'TEST_PAYMENT_NOT_SHIPPABLE',
    message: 'UAT test order: no money was received, so it cannot be shipped or delivered',
};
const shipBlocked = (order, to) => order?.testPayment === true && (to === 'shipped' || to === 'delivered');
exports.shipBlocked = shipBlocked;
/** Extra update filter for the same rule, so even a racing write cannot ship a test order. */
const notShippableTestFilter = (to) => (to === 'shipped' || to === 'delivered' ? { testPayment: { $ne: true } } : {});
exports.notShippableTestFilter = notShippableTestFilter;
const canMoveOrderStatus = (from, to) => to === 'cancelled' ? from === 'processing' || from === 'shipped' : from !== 'cancelled' && RANK[to] > RANK[from];
exports.canMoveOrderStatus = canMoveOrderStatus;
//# sourceMappingURL=orderStatus.js.map