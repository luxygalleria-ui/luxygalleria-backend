import mongoose, { Schema } from 'mongoose';

// One row per accepted ERP webhook event; the unique eventId makes redelivery a no-op.
const erpEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    status: { type: String },
    occurredAt: { type: Date },
    outcome: { type: String, required: true }, // applied | unchanged | stale
    keyId: { type: String },
  },
  { timestamps: true }
);

export const ErpEvent = mongoose.model('ErpEvent', erpEventSchema);
