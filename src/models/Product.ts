import mongoose, { Document, Schema } from 'mongoose';

interface IVariant {
  _id?: mongoose.Types.ObjectId | string;
  volume: string;
  price: number; // backward compatibility
  oldPrice?: number; // backward compatibility
  offerPrice: number;
  actualPrice: number;
  stock: number;
  weight: number;
  image: string;
  sku?: string;
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
  price: { type: Number, required: true }, // backward compatibility
  oldPrice: { type: Number }, // backward compatibility
  offerPrice: { type: Number, required: true },
  actualPrice: { type: Number, required: true },
  stock: { type: Number, required: true, default: 0 },
  weight: { type: Number, required: true, default: 0 },
  image: { type: String },
  sku: { type: String },
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
