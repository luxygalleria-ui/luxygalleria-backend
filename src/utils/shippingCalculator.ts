import mongoose from 'mongoose';
import { Product } from '../models/Product';
import { Settings } from '../models/Settings';
import { legacyShippingConfig, loadCheckoutSettings } from './checkoutSettings';
import { priceOrder, Selection, OrderQuote } from './orderPricing';

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
 * Resolves the pre-zone shipping config, newest source wins: admin Settings (DB) -> environment -> built-in defaults.
 * A failed settings read throws: charging environment defaults instead of the admin's rates would be a wrong charge.
 */
export const resolveShippingConfig = async (): Promise<ShippingConfig> => legacyShippingConfig(await Settings.findOne().lean());

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

/** A cart line priced from the database; the only price checkout may trust. */
export interface ResolvedLine {
  product: string;
  variantId: string;
  price: number;
  weight: number;
  quantity: number;
  stock: number;
  name: string;
  requiresSpecialPackaging: boolean;
  taxRate: number | null;
}

export const MAX_QTY_PER_LINE = 100;

/**
 * Prices a cart for checkout: prices, weights and product flags come from the database only (never the client),
 * settings are read fresh, and priceOrder applies shipping, packaging, pickup and tax rules.
 */
export const calculateShippingForItems = async (
  items: InputItem[],
  selection: Selection = {}
): Promise<OrderQuote & { lines: ResolvedLine[] }> => {
  const { settings, fallbackItemWeightKg } = await loadCheckoutSettings();
  const resolved: ResolvedLine[] = [];

  for (const item of items) {
    // Whole units only: fractional quantities would let a buyer pay for 0.01 of an item.
    if (!item || !item.product || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QTY_PER_LINE) {
      throw new Error(`Invalid item details: quantity must be a whole number between 1 and ${MAX_QTY_PER_LINE}`);
    }
    if (!mongoose.isValidObjectId(item.product)) {
      throw new Error('Invalid product id');
    }

    const product = await Product.findById(item.product);
    if (!product) {
      throw new Error(`Product not found: ${item.product}`);
    }

    let itemPrice = 0;
    let itemWeight = 0;

    let variant: any = null;
    if (item.variantId && product.variants && product.variants.length > 0) {
      variant = product.variants.find((v: any) => v._id && v._id.toString() === item.variantId?.toString());
    }
    if (!variant && item.size && product.variants && product.variants.length > 0) {
      variant = product.variants.find((v: any) => v.volume?.toLowerCase() === item.size?.toLowerCase());
    }

    if (variant) {
      itemPrice = variant.offerPrice || variant.price || 0;
      // Weight from the stored variant only (its weight, else its own volume label, else the product); never the client's size text
      itemWeight = (variant.weight && variant.weight > 0) ? variant.weight : (parseWeightFromVolume(variant.volume || '') || product.weight || 0);
    } else if (product.variants && product.variants.length > 0) {
      const defaultVariant = product.variants[0];
      variant = defaultVariant;
      itemPrice = defaultVariant.offerPrice || defaultVariant.price || 0;
      const parsedDefaultWeight = parseWeightFromVolume(defaultVariant.volume || '');
      itemWeight = (defaultVariant.weight && defaultVariant.weight > 0) ? defaultVariant.weight : (parsedDefaultWeight || product.weight || 0);
    } else {
      throw new Error(`Product ${product.name} has no variants configured`);
    }

    // A missing or zero price would sell the item for free: refuse instead
    if (!(Number.isFinite(itemPrice) && itemPrice > 0)) {
      throw new Error(`${product.name} is not available for purchase right now (no valid price)`);
    }

    resolved.push({
      product: product._id.toString(),
      variantId: variant._id.toString(),
      price: itemPrice,
      weight: itemWeight,
      quantity: item.quantity,
      stock: Number(variant.stock) || 0,
      name: product.name,
      requiresSpecialPackaging: product.requiresSpecialPackaging === true,
      taxRate: typeof product.taxRate === 'number' ? product.taxRate : null,
    });
  }

  return { ...priceOrder(resolved, settings, selection, { fallbackItemWeightKg }), lines: resolved };
};
