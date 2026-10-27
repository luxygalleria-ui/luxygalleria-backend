import mongoose, { Document, Schema } from 'mongoose';

export interface IOrder extends Document {
  user: mongoose.Types.ObjectId;
  items: {
    product: mongoose.Types.ObjectId;
    variantId?: mongoose.Types.ObjectId | string;
    /** Purchase-time snapshots (absent on orders placed before they were recorded). */
    name?: string;
    sku?: string;
    quantity: number;
    price: number;
    size?: string;
    image?: string;
    subtotal?: number;
    taxRate?: number | null;
    taxAmount?: number;
  }[];
  /** Orders placed before fulfilment options existed have no value here and are home deliveries. */
  fulfillmentMethod?: 'delivery' | 'pickup';
  shippingMethod?: 'land' | 'air';
  shippingZone?: 'kerala' | 'outsideKerala';
  /** Store details as shown to the customer when the pickup order was placed. */
  pickupDetails?: { storeName?: string; address?: string; openingHours?: string; phone?: string; instructions?: string };
  pickupFee?: number;
  specialPackagingFee?: number;
  tax?: { enabled: boolean; pricesIncludeTax: boolean; taxableValue: number; taxAmount: number; addedToTotal: number };
  shippingAddress?: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  subtotal: number;
  discount: number;
  shippingFee: number;
  total: number;
  paymentMethod: string;
  paymentStatus: 'pending' | 'completed' | 'failed' | 'refunded';
  orderStatus: 'processing' | 'shipped' | 'delivered' | 'cancelled';
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  erpOrderId?: string;
  trackingNumber?: string;
  statusUpdatedAt?: Date;
  /** Superadmin corrections that the normal forward-only status rule would refuse. Append-only audit trail. */
  statusCorrections?: { at: Date; by: string; from: string; to: string; reason: string }[];
  /** The checkout session (quote snapshot) this order was created from; absent on older orders. */
  checkoutSession?: mongoose.Types.ObjectId;
  /** Set when payment succeeded but the order could not be fulfilled, e.g. stock ran out after the session expired. */
  fulfillmentIssue?: string;
  refund?: {
    status: 'required' | 'requested' | 'pending' | 'processed' | 'failed';
    amountPaise?: number;
    razorpayRefundId?: string;
    reason?: string;
    lastError?: string;
    events: { at: Date; by?: string; action: string; outcome?: string; detail?: string }[];
  };
  createdAt: Date;
  updatedAt: Date;
}

function isDelivery(this: any) {
  return this.fulfillmentMethod !== 'pickup';
}

const OrderSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    items: [
      {
        product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        variantId: { type: Schema.Types.ObjectId, required: true },
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
      street: { type: String, required: isDelivery },
      city: { type: String, required: isDelivery },
      state: { type: String, required: isDelivery },
      zipCode: { type: String, required: isDelivery },
      country: { type: String, required: isDelivery },
    },
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
    // Set by the ERP order-status webhook
    erpOrderId: { type: String },
    trackingNumber: { type: String },
    // Written in the same atomic update as the status it records (paymentController.correctOrderStatus); never edited
    statusCorrections: [{ at: { type: Date, required: true }, by: { type: String, required: true }, from: { type: String, required: true },
      to: { type: String, required: true }, reason: { type: String, required: true }, _id: false }],
    statusUpdatedAt: { type: Date }, // when the status last changed: ERP event time, or the time of an admin change; older ERP events are ignored
    checkoutSession: { type: Schema.Types.ObjectId, ref: 'CheckoutSession' },
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
  },
  { timestamps: true }
);

// Stable order for ERP incremental sync (GET /erp/orders?updatedSince=)
OrderSchema.index({ updatedAt: 1, _id: 1 });

// One order per Razorpay order: closes the race between verify's duplicate check and save.
OrderSchema.index({ razorpayOrderId: 1 }, { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string' } } });

export default mongoose.model<IOrder>('Order', OrderSchema);
