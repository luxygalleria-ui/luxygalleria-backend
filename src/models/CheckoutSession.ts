import mongoose, { Document, Schema } from 'mongoose';

/**
 * Immutable server-side quote behind one Razorpay order. Created at create-order (after stock is reserved),
 * consumed exactly once when the payment is confirmed. Payment is verified against THIS snapshot, so a settings
 * or price change after "Pay" can neither break a legitimate payment nor change what the customer is charged.
 *
 * status: pending -> processing -> paid | unfulfillable;  pending -> expired (stock released) -> processing -> ...
 */
export type SessionStatus = 'pending' | 'processing' | 'paid' | 'expired' | 'unfulfillable';

export interface ISessionItem {
  product: mongoose.Types.ObjectId;
  variantId: mongoose.Types.ObjectId;
  name: string;
  price: number;
  quantity: number;
  weight: number;
  size?: string;
  image?: string;
  subtotal: number;
  requiresSpecialPackaging: boolean;
  taxRate?: number | null;
  taxAmount?: number;
}

export interface ICheckoutSession extends Document {
  user: mongoose.Types.ObjectId;
  razorpayOrderId: string;
  isMock: boolean;
  status: SessionStatus;
  stockReserved: boolean;
  expiresAt: Date;
  items: ISessionItem[];
  fulfillmentMethod: 'delivery' | 'pickup';
  shippingMethod?: 'land' | 'air';
  shippingZone?: 'kerala' | 'outsideKerala';
  shippingAddress?: Record<string, string>;
  pickupDetails?: Record<string, string>;
  breakdown: {
    subtotal: number; discount: number; totalWeight: number; baseShipping: number; extraWeightCharge: number; shipping: number;
    freeShippingApplied: boolean; specialPackagingFee: number; pickupFee: number; grandTotal: number;
    specialPackaging: { weightG: number; steps: number; rule: unknown };
    tax: { enabled: boolean; pricesIncludeTax: boolean; taxableValue: number; taxAmount: number; addedToTotal: number };
  };
  amountPaise: number;
  currency: 'INR';
  /** Hash of the effective checkout settings used, and when the settings document was last changed. */
  settingsVersion: string;
  settingsUpdatedAt?: Date;
  order?: mongoose.Types.ObjectId;
  paymentId?: string;
  events: { at: Date; type: string; detail?: string }[];
  createdAt: Date;
  updatedAt: Date;
}

const itemSchema = new Schema<ISessionItem>({
  product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: Schema.Types.ObjectId, required: true },
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

const sessionSchema = new Schema<ICheckoutSession>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  razorpayOrderId: { type: String, required: true, unique: true },
  isMock: { type: Boolean, default: false },
  status: { type: String, enum: ['pending', 'processing', 'paid', 'expired', 'unfulfillable'], default: 'pending', index: true },
  stockReserved: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
  items: { type: [itemSchema], required: true },
  fulfillmentMethod: { type: String, enum: ['delivery', 'pickup'], required: true },
  shippingMethod: { type: String, enum: ['land', 'air'] },
  shippingZone: { type: String, enum: ['kerala', 'outsideKerala'] },
  shippingAddress: { type: Schema.Types.Mixed },
  pickupDetails: { type: Schema.Types.Mixed },
  breakdown: { type: Schema.Types.Mixed, required: true },
  amountPaise: { type: Number, required: true },
  currency: { type: String, enum: ['INR'], default: 'INR' },
  settingsVersion: { type: String, required: true },
  settingsUpdatedAt: Date,
  order: { type: Schema.Types.ObjectId, ref: 'Order' },
  paymentId: String,
  events: [{ at: { type: Date, default: Date.now }, type: { type: String }, detail: String, _id: false }],
}, { timestamps: true });

// Expiry sweep: unpaid sessions past their deadline
sessionSchema.index({ status: 1, expiresAt: 1 });

export const CheckoutSession = mongoose.model<ICheckoutSession>('CheckoutSession', sessionSchema);
