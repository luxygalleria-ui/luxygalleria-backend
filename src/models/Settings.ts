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
}

const settingsSchema = new Schema<ISettings>(
  {
    bannerText: { type: String, default: '' },
    isBannerActive: { type: Boolean, default: false },
    footerText: { type: String, default: '© 2026 Luxy Galleria. All rights reserved.' },
    whatsappNumber: { type: String, default: '7012552969' },
    primaryColor: { type: String, default: '#8B5E34' },
    secondaryColor: { type: String, default: '#F5F1E8' },
    shippingBelow500g: { type: Number, default: 40 },
    shippingAbove500g: { type: Number, default: 80 },
    shippingWeightThreshold: { type: Number, default: 500 },
  },
  { timestamps: true }
);

export const Settings = mongoose.model<ISettings>('Settings', settingsSchema);
