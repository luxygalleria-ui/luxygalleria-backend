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
exports.CheckoutSession = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const itemSchema = new mongoose_1.Schema({
    product: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: mongoose_1.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    weight: { type: Number, required: true },
    size: String,
    image: String,
    subtotal: { type: Number, required: true },
    requiresSpecialPackaging: { type: Boolean, default: false },
    taxRate: Number,
    taxAmount: Number,
}, { _id: false });
const sessionSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    razorpayOrderId: { type: String, required: true, unique: true },
    isMock: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'processing', 'paid', 'expired', 'unfulfillable'], default: 'pending', index: true },
    stockReserved: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
    items: { type: [itemSchema], required: true },
    fulfillmentMethod: { type: String, enum: ['delivery', 'pickup'], required: true },
    shippingMethod: { type: String, enum: ['land', 'air'] },
    shippingZone: { type: String, enum: ['kerala', 'outsideKerala'] },
    shippingAddress: { type: mongoose_1.Schema.Types.Mixed },
    pickupDetails: { type: mongoose_1.Schema.Types.Mixed },
    breakdown: { type: mongoose_1.Schema.Types.Mixed, required: true },
    amountPaise: { type: Number, required: true },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    settingsVersion: { type: String, required: true },
    settingsUpdatedAt: Date,
    order: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Order' },
    paymentId: String,
    events: [{ at: { type: Date, default: Date.now }, type: { type: String }, detail: String, _id: false }],
}, { timestamps: true });
// Expiry sweep: unpaid sessions past their deadline
sessionSchema.index({ status: 1, expiresAt: 1 });
exports.CheckoutSession = mongoose_1.default.model('CheckoutSession', sessionSchema);
//# sourceMappingURL=CheckoutSession.js.map