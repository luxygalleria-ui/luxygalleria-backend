import { Product } from '../models/Product';
import { Settings } from '../models/Settings';

export interface ShippingCalculationResult {
  subtotal: number;
  totalWeight: number;
  baseShipping: number;
  extraWeightCharge: number;
  shipping: number;
  grandTotal: number;
  freeShippingApplied: boolean;
}

export interface InputItem {
  product: string;
  quantity: number;
  size?: string;
  variantId?: string;
}

export interface ShippingConfig {
  /** Cart weight at or above which the higher shipping charge applies (kg). */
  WEIGHT_THRESHOLD_KG: number;
  /** Charge when total cart weight is strictly below the threshold. */
  SHIPPING_BELOW_THRESHOLD: number;
  /** Charge when total cart weight is at or above the threshold. */
  SHIPPING_ABOVE_THRESHOLD: number;
  /** Weight included in the base charge; every started kg beyond it is surcharged. */
  BASE_WEIGHT_KG: number;
  EXTRA_SHIPPING_PER_KG: number;
  /** Subtotal at or above which shipping is free. 0 disables the tier. */
  FREE_SHIPPING_THRESHOLD: number;
  /** Substituted when an item has no usable weight. 0 keeps such items weightless. */
  FALLBACK_ITEM_WEIGHT_KG: number;
}

export const DEFAULT_SHIPPING_CONFIG: ShippingConfig = {
  WEIGHT_THRESHOLD_KG: 0.5,
  SHIPPING_BELOW_THRESHOLD: 40,
  SHIPPING_ABOVE_THRESHOLD: 80,
  BASE_WEIGHT_KG: 1,
  EXTRA_SHIPPING_PER_KG: 20,
  FREE_SHIPPING_THRESHOLD: 0,
  FALLBACK_ITEM_WEIGHT_KG: 0,
};

/** Reads a positive number, falling back when unset, non-numeric or negative. */
const num = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Resolves the shipping config, newest source wins:
 * admin Settings (DB) -> environment -> built-in defaults.
 *
 * The admin panel stores the weight threshold in grams; everything here is kg.
 */
export const resolveShippingConfig = async (): Promise<ShippingConfig> => {
  const fromEnv: ShippingConfig = {
    WEIGHT_THRESHOLD_KG: num(process.env.WEIGHT_THRESHOLD_KG, DEFAULT_SHIPPING_CONFIG.WEIGHT_THRESHOLD_KG),
    SHIPPING_BELOW_THRESHOLD: num(process.env.SHIPPING_BELOW_THRESHOLD, DEFAULT_SHIPPING_CONFIG.SHIPPING_BELOW_THRESHOLD),
    SHIPPING_ABOVE_THRESHOLD: num(process.env.SHIPPING_ABOVE_THRESHOLD, DEFAULT_SHIPPING_CONFIG.SHIPPING_ABOVE_THRESHOLD),
    BASE_WEIGHT_KG: num(process.env.BASE_WEIGHT_KG, DEFAULT_SHIPPING_CONFIG.BASE_WEIGHT_KG),
    EXTRA_SHIPPING_PER_KG: num(process.env.EXTRA_SHIPPING_PER_KG, DEFAULT_SHIPPING_CONFIG.EXTRA_SHIPPING_PER_KG),
    FREE_SHIPPING_THRESHOLD: num(process.env.FREE_SHIPPING_THRESHOLD, DEFAULT_SHIPPING_CONFIG.FREE_SHIPPING_THRESHOLD),
    FALLBACK_ITEM_WEIGHT_KG: num(process.env.FALLBACK_ITEM_WEIGHT_KG, DEFAULT_SHIPPING_CONFIG.FALLBACK_ITEM_WEIGHT_KG),
  };

  try {
    const settings = await Settings.findOne().lean();
    if (!settings) return fromEnv;

    return {
      ...fromEnv,
      WEIGHT_THRESHOLD_KG: num(settings.shippingWeightThreshold, fromEnv.WEIGHT_THRESHOLD_KG * 1000) / 1000,
      SHIPPING_BELOW_THRESHOLD: num(settings.shippingBelow500g, fromEnv.SHIPPING_BELOW_THRESHOLD),
      SHIPPING_ABOVE_THRESHOLD: num(settings.shippingAbove500g, fromEnv.SHIPPING_ABOVE_THRESHOLD),
      FREE_SHIPPING_THRESHOLD: num(settings.freeShippingThreshold, fromEnv.FREE_SHIPPING_THRESHOLD),
    };
  } catch (err) {
    // Never fail a checkout because the settings lookup broke.
    console.error('Failed to load shipping settings, falling back to env:', err);
    return fromEnv;
  }
};

/**
 * Dynamically parses weight from a volume/size string (e.g. "500G", "1kg", "250ml", "1L").
 * Returns the weight in kilograms (kg) or null if it cannot be parsed.
 */
export const parseWeightFromVolume = (volume: string): number | null => {
  if (!volume) return null;
  const match = volume.match(/(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|l|ltr|liter|liters|litre|litres|ml)/i);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'kg' || unit === 'l' || unit === 'ltr' || unit === 'liter' || unit === 'liters' || unit === 'litre' || unit === 'litres') {
      return value;
    } else if (unit === 'g' || unit === 'gm' || unit === 'gms' || unit === 'ml') {
      return value / 1000;
    }
  }
  return null;
};

/**
 * The single implementation of the shipping formula. Operates on the whole cart:
 * weights and prices are summed across every line before any threshold is tested.
 */
export const calculateShippingPure = (
  items: Array<{ price: number; weight: number; quantity: number }>,
  config: ShippingConfig = DEFAULT_SHIPPING_CONFIG
): ShippingCalculationResult => {
  let subtotal = 0;
  let totalWeight = 0;

  for (const item of items) {
    const quantity = num(item.quantity, 0);
    // A missing/invalid weight contributes the configured fallback, not NaN.
    const weight = num(item.weight, config.FALLBACK_ITEM_WEIGHT_KG) || config.FALLBACK_ITEM_WEIGHT_KG;
    subtotal += num(item.price, 0) * quantity;
    totalWeight += weight * quantity;
  }

  let baseShipping = 0;
  let extraWeightCharge = 0;
  let shipping = 0;
  let grandTotal = 0;
  let freeShippingApplied = false;

  const roundedWeight = Math.round(totalWeight * 1000) / 1000;

  if (subtotal > 0) {
    // Strictly below the threshold pays the lower rate; at or above pays the higher.
    baseShipping = roundedWeight < config.WEIGHT_THRESHOLD_KG
      ? config.SHIPPING_BELOW_THRESHOLD
      : config.SHIPPING_ABOVE_THRESHOLD;

    // Every started kg past BASE_WEIGHT_KG adds a surcharge.
    const extraWeight = Math.max(roundedWeight - config.BASE_WEIGHT_KG, 0);
    extraWeightCharge = Math.ceil(extraWeight) * config.EXTRA_SHIPPING_PER_KG;
    shipping = baseShipping + extraWeightCharge;

    // Free shipping tier overrides everything above. 0 means "not configured".
    if (config.FREE_SHIPPING_THRESHOLD > 0 && subtotal >= config.FREE_SHIPPING_THRESHOLD) {
      freeShippingApplied = true;
      baseShipping = 0;
      extraWeightCharge = 0;
      shipping = 0;
    }

    grandTotal = subtotal + shipping;
  }

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    totalWeight: roundedWeight,
    baseShipping,
    extraWeightCharge,
    shipping,
    grandTotal: Math.round(grandTotal * 100) / 100,
    freeShippingApplied,
  };
};

/**
 * Calculates shipping for a list of cart items.
 * Fetches prices and weights directly from the database for security, then
 * defers to calculateShippingPure so there is one copy of the formula.
 */
export const calculateShippingForItems = async (items: InputItem[]): Promise<ShippingCalculationResult> => {
  const config = await resolveShippingConfig();
  const resolved: Array<{ price: number; weight: number; quantity: number }> = [];

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

    let variant = null;
    if (item.variantId && product.variants && product.variants.length > 0) {
      variant = product.variants.find((v: any) => v._id && v._id.toString() === item.variantId?.toString());
    }
    if (!variant && item.size && product.variants && product.variants.length > 0) {
      variant = product.variants.find((v: any) => v.volume?.toLowerCase() === item.size?.toLowerCase());
    }

    if (variant) {
      itemPrice = variant.offerPrice || variant.price || 0;
      itemWeight = (variant.weight && variant.weight > 0) ? variant.weight : (parsedVariantWeight || product.weight || 0);
    } else if (product.variants && product.variants.length > 0) {
      const defaultVariant = product.variants[0];
      itemPrice = defaultVariant.offerPrice || defaultVariant.price || 0;
      const parsedDefaultWeight = parseWeightFromVolume(defaultVariant.volume || '');
      itemWeight = (defaultVariant.weight && defaultVariant.weight > 0) ? defaultVariant.weight : (parsedDefaultWeight || product.weight || 0);
    } else {
      throw new Error(`Product ${product.name} has no variants configured`);
    }

    resolved.push({ price: itemPrice, weight: itemWeight, quantity: item.quantity });
  }

  return calculateShippingPure(resolved, config);
};
