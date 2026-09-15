import mongoose, { Document, Schema } from 'mongoose';

export interface ISettings extends Document {
  bannerText: string;
  isBannerActive: boolean;
  footerText: string;
  whatsappNumber: string;
  primaryColor: string;
  secondaryColor: string;
  shippingBelow500g: number;
  shippingAbove500g: number;
  shippingWeightThreshold: number;
  /** Subtotal at or above which shipping is free. 0 disables the tier. */
  freeShippingThreshold: number;
  /** Heading and subheading of the storefront /gifting page. */
  giftingTitle: string;
  giftingSubtitle: string;
  /** Heading and subheading of the storefront /new-arrivals page. */
  newArrivalsTitle: string;
  newArrivalsSubtitle: string;
}

const settingsSchema = new Schema<ISettings>(
  {
    bannerText: { type: String, default: '' },
    isBannerActive: { type: Boolean, default: false },
    footerText: { type: String, default: '© 2026 Luxy Galleria. All rights reserved.' },
    whatsappNumber: { type: String, default: '917736989068' },
    primaryColor: { type: String, default: '#8B5E34' },
    secondaryColor: { type: String, default: '#F5F1E8' },
    shippingBelow500g: { type: Number, default: 40 },
    shippingAbove500g: { type: Number, default: 80 },
    shippingWeightThreshold: { type: Number, default: 500 },
    freeShippingThreshold: { type: Number, default: 0 },
    giftingTitle: { type: String, default: 'Gifting' },
    giftingSubtitle: { type: String, default: 'Curated picks, ready to be wrapped.' },
    newArrivalsTitle: { type: String, default: 'New Arrivals' },
    newArrivalsSubtitle: { type: String, default: 'The latest additions to the collection.' },
  },
  { timestamps: true }
);

export const Settings = mongoose.model<ISettings>('Settings', settingsSchema);
