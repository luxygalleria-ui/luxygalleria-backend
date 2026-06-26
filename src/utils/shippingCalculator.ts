import { Product } from '../models/Product';

export interface ShippingCalculationResult {
  subtotal: number;
  totalWeight: number;
  baseShipping: number;
  extraWeightCharge: number;
  shipping: number;
  grandTotal: number;
}

export interface InputItem {
  product: string;
  quantity: number;
  size?: string;
}

/**
 * Dynamically parses weight from a volume/size string (e.g. "500G", "1kg", "250ml", "1L").
 * Returns the weight in kilograms (kg) or null if it cannot be parsed.
 */
export const parseWeightFromVolume = (volume: string): number | null => {
  if (!volume) return null;
  const match = volume.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml)/i);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'kg' || unit === 'l') {
      return value;
    } else if (unit === 'g' || unit === 'ml') {
      return value / 1000;
    }
  }
  return null;
};

/**
 * Calculates shipping details for a list of cart items.
 * Fetches prices and weights directly from the database for security.
 */
export const calculateShippingForItems = async (items: InputItem[]): Promise<ShippingCalculationResult> => {
  const WEIGHT_THRESHOLD_KG = Number(process.env.WEIGHT_THRESHOLD_KG || 0.5);
  const SHIPPING_BELOW_THRESHOLD = Number(process.env.SHIPPING_BELOW_THRESHOLD || 40);
  const SHIPPING_ABOVE_THRESHOLD = Number(process.env.SHIPPING_ABOVE_THRESHOLD || 80);
  const BASE_WEIGHT_KG = Number(process.env.BASE_WEIGHT_KG || 1);
  const EXTRA_SHIPPING_PER_KG = Number(process.env.EXTRA_SHIPPING_PER_KG || 20);

  let subtotal = 0;
  let totalWeight = 0;

  for (const item of items) {
    if (!item.product || !item.quantity || item.quantity <= 0) {
      throw new Error('Invalid item details: product and quantity are required');
    }

    const product = await Product.findById(item.product);
    if (!product) {
      throw new Error(`Product not found: ${item.product}`);
    }

    let itemPrice = 0;
    let itemWeight = 0;

    const parsedVariantWeight = parseWeightFromVolume(item.size || '');

    if (item.size && product.variants && product.variants.length > 0) {
      const variant = product.variants.find((v: any) => v.volume.toLowerCase() === item.size?.toLowerCase());
      if (variant) {
        itemPrice = variant.price;
        itemWeight = variant.weight || parsedVariantWeight || product.weight || 0;
      } else {
        const defaultVariant = product.variants[0];
        itemPrice = defaultVariant.price;
        const parsedDefaultWeight = parseWeightFromVolume(defaultVariant.volume || '');
        itemWeight = defaultVariant.weight || parsedDefaultWeight || product.weight || 0;
      }
    } else if (product.variants && product.variants.length > 0) {
      const defaultVariant = product.variants[0];
      itemPrice = defaultVariant.price;
      const parsedDefaultWeight = parseWeightFromVolume(defaultVariant.volume || '');
      itemWeight = defaultVariant.weight || parsedDefaultWeight || product.weight || 0;
    } else {
      throw new Error(`Product ${product.name} has no variants configured`);
    }

    subtotal += itemPrice * item.quantity;
    totalWeight += itemWeight * item.quantity;
  }

  let baseShipping = 0;
  let extraWeightCharge = 0;
  let shipping = 0;
  let grandTotal = 0;

  if (subtotal > 0) {
    if (totalWeight < WEIGHT_THRESHOLD_KG) {
      baseShipping = SHIPPING_BELOW_THRESHOLD;
    } else {
      baseShipping = SHIPPING_ABOVE_THRESHOLD;
    }

    // Weight exceeding BASE_WEIGHT_KG
    const extraWeight = Math.max(totalWeight - BASE_WEIGHT_KG, 0);
    extraWeightCharge = Math.ceil(extraWeight) * EXTRA_SHIPPING_PER_KG;
    shipping = baseShipping + extraWeightCharge;
    grandTotal = subtotal + shipping;
  }

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    totalWeight: Math.round(totalWeight * 1000) / 1000, // round to 3 decimal places
    baseShipping,
    extraWeightCharge,
    shipping,
    grandTotal: Math.round(grandTotal * 100) / 100,
  };
};

/**
 * Pure function for running unit tests without hitting database
 */
export const calculateShippingPure = (
  items: Array<{ price: number; weight: number; quantity: number }>,
  config = {
    WEIGHT_THRESHOLD_KG: 0.5,
    SHIPPING_BELOW_THRESHOLD: 40,
    SHIPPING_ABOVE_THRESHOLD: 80,
    BASE_WEIGHT_KG: 1,
    EXTRA_SHIPPING_PER_KG: 20
  }
): ShippingCalculationResult => {
  let subtotal = 0;
  let totalWeight = 0;

  for (const item of items) {
    subtotal += item.price * item.quantity;
    totalWeight += item.weight * item.quantity;
  }

  let baseShipping = 0;
  let extraWeightCharge = 0;
  let shipping = 0;
  let grandTotal = 0;

  if (subtotal > 0) {
    if (totalWeight < config.WEIGHT_THRESHOLD_KG) {
      baseShipping = config.SHIPPING_BELOW_THRESHOLD;
    } else {
      baseShipping = config.SHIPPING_ABOVE_THRESHOLD;
    }

    const extraWeight = Math.max(totalWeight - config.BASE_WEIGHT_KG, 0);
    extraWeightCharge = Math.ceil(extraWeight) * config.EXTRA_SHIPPING_PER_KG;
    shipping = baseShipping + extraWeightCharge;
    grandTotal = subtotal + shipping;
  }

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    totalWeight: Math.round(totalWeight * 1000) / 1000,
    baseShipping,
    extraWeightCharge,
    shipping,
    grandTotal: Math.round(grandTotal * 100) / 100,
  };
};
