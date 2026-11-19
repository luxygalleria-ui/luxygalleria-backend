"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canMoveOrderStatus = exports.ORDER_STATUSES = void 0;
/** Fulfilment statuses of an order. Payment status is separate (Order.paymentStatus) and never changed by these rules. */
exports.ORDER_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'];
const RANK = { processing: 0, shipped: 1, delivered: 2 };
/**
 * Forward only; cancel allowed until delivered; delivered and cancelled are final.
 * The one rule for both the ERP status callback and the admin status change.
 */
const canMoveOrderStatus = (from, to) => to === 'cancelled' ? from === 'processing' || from === 'shipped' : from !== 'cancelled' && RANK[to] > RANK[from];
exports.canMoveOrderStatus = canMoveOrderStatus;
//# sourceMappingURL=orderStatus.js.map