"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importStar(require("mongoose"));
function isDelivery() {
    return this.fulfillmentMethod !== 'pickup';
}
const OrderSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [
        {
            product: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Product', required: true },
            variantId: { type: mongoose_1.Schema.Types.ObjectId, required: true },
            // Product name and variant SKU as sold, so later catalogue edits or deletions never change order history
            name: { type: String },
            sku: { type: String },
            quantity: { type: Number, required: true },
            price: { type: Number, required: true },
            size: { type: String },
            image: { type: String },
            subtotal: { type: Number },
            taxRate: { type: Number },
            taxAmount: { type: Number },
        },
    ],
    // No defaults: existing orders keep exactly the fields they were saved with
    fulfillmentMethod: { type: String, enum: ['delivery', 'pickup'] },
    shippingMethod: { type: String, enum: ['land', 'air'] },
    shippingZone: { type: String, enum: ['kerala', 'outsideKerala'] },
    pickupDetails: {
        storeName: { type: String }, address: { type: String }, openingHours: { type: String }, phone: { type: String }, instructions: { type: String },
    },
    pickupFee: { type: Number },
    specialPackagingFee: { type: Number },
    tax: {
        enabled: { type: Boolean }, pricesIncludeTax: { type: Boolean }, taxableValue: { type: Number }, taxAmount: { type: Number }, addedToTotal: { type: Number },
    },
    // Required for home delivery; a store-pickup order has no delivery address
    shippingAddress: {
        // Optional: the address form and saved addresses allow no street; requiring it here failed paid orders at save
        street: { type: String },
        city: { type: String, required: isDelivery },
        state: { type: String, required: isDelivery },
        zipCode: { type: String, required: isDelivery },
        country: { type: String, required: isDelivery },
    },
    // A snapshot like shippingAddress, validated at checkout; optional so older orders stay valid
    billingAddress: { street: String, city: String, state: String, zipCode: String, country: String },
    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    shippingFee: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentMethod: { type: String, required: true },
    paymentStatus: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded'],
        default: 'pending',
    },
    orderStatus: {
        type: String,
        enum: ['processing', 'shipped', 'delivered', 'cancelled'],
        default: 'processing',
    },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    // ICICI Orange PG: txnID from the gateway, the refund request's merchantTxnNo (reused on retry), settlement advice
    iciciTxnId: { type: String },
    iciciRefundTxnNo: { type: String },
    iciciSettlement: { type: mongoose_1.Schema.Types.Mixed },
    // Set by the ERP order-status webhook
    erpOrderId: { type: String },
    trackingNumber: { type: String },
    // Written in the same atomic update as the status it records (paymentController.correctOrderStatus); never edited
    statusCorrections: [{ at: { type: Date, required: true }, by: { type: String, required: true }, from: { type: String, required: true },
            to: { type: String, required: true }, reason: { type: String, required: true }, _id: false }],
    statusUpdatedAt: { type: Date }, // when the status last changed: ERP event time, or the time of an admin change; older ERP events are ignored
    checkoutSession: { type: mongoose_1.Schema.Types.ObjectId, ref: 'CheckoutSession' },
    fulfillmentIssue: { type: String },
    // Refund workflow (admin-initiated; see paymentController). Absent = no refund ever needed or requested.
    refund: {
        status: { type: String, enum: ['required', 'requested', 'pending', 'processed', 'failed'] },
        amountPaise: { type: Number },
        razorpayRefundId: { type: String },
        reason: { type: String },
        lastError: { type: String },
        events: [{ at: { type: Date, default: Date.now }, by: String, action: String, outcome: String, detail: String, _id: false }],
    },
}, { timestamps: true });
// Stable order for ERP incremental sync (GET /erp/orders?updatedSince=)
OrderSchema.index({ updatedAt: 1, _id: 1 });
// One order per Razorpay order: closes the race between verify's duplicate check and save.
OrderSchema.index({ razorpayOrderId: 1 }, { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string' } } });
exports.default = mongoose_1.default.model('Order', OrderSchema);
//# sourceMappingURL=Order.js.map