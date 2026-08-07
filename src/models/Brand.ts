import mongoose, { Document, Schema } from 'mongoose';

export interface IBrand extends Document {
  name: string;
  logo: string;
  status: string;
  displayOrder: number;
}

const brandSchema = new Schema<IBrand>(
  {
    name: { type: String, required: true, trim: true },
    logo: { type: String, default: '' },
    status: { type: String, default: 'ACTIVE' },
    displayOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Brand = mongoose.model<IBrand>('Brand', brandSchema);
