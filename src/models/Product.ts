import mongoose, { Document, Schema } from 'mongoose';

interface IVariant {
  volume: string;
  price: number;
  oldPrice?: number;
  weight?: number;
}

export interface IProduct extends Document {
  name: string;
  category: string;
  description: string;
  variants: IVariant[];
  starRating: number;
  reviewsCount: number;
  offerText?: string;
  keyFeatures?: string;
  images: string[];
  status: string;
  showOnLandingPage: boolean;
  stock: number;
  weight: number;
}

const variantSchema = new Schema<IVariant>({
  volume: { type: String, required: true },
  price: { type: Number, required: true },
  oldPrice: { type: Number },
  weight: { type: Number, default: 0 },
});

const productSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true },
    description: { type: String, required: true },
    variants: [variantSchema],
    starRating: { type: Number, default: 0, min: 0, max: 5 },
    reviewsCount: { type: Number, default: 0 },
    offerText: { type: String },
    keyFeatures: { type: String },
    images: [{ type: String }],
    status: { type: String, default: 'In Stock' },
    showOnLandingPage: { type: Boolean, default: false },
    stock: { type: Number, default: 0 },
    weight: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Product = mongoose.model<IProduct>('Product', productSchema);
