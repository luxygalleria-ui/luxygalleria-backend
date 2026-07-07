"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateShippingPure = exports.calculateShippingForItems = exports.parseWeightFromVolume = void 0;
const Product_1 = require("../models/Product");
/**
 * Dynamically parses weight from a volume/size string (e.g. "500G", "1kg", "250ml", "1L").
 * Returns the weight in kilograms (kg) or null if it cannot be parsed.
 */
const parseWeightFromVolume = (volume) => {
    if (!volume)
        return null;
    const match = volume.match(/(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|l|ltr|liter|liters|litre|litres|ml)/i);
    if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        if (unit === 'kg' || unit === 'l' || unit === 'ltr' || unit === 'liter' || unit === 'liters' || unit === 'litre' || unit === 'litres') {
            return value;
        }
        else if (unit === 'g' || unit === 'gm' || unit === 'gms' || unit === 'ml') {
            return value / 1000;
        }
    }
    return null;
};
exports.parseWeightFromVolume = parseWeightFromVolume;
/**
 * Calculates shipping details for a list of cart items.
 * Fetches prices and weights directly from the database for security.
 */
const calculateShippingForItems = async (items) => {
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
        const product = await Product_1.Product.findById(item.product);
        if (!product) {
            throw new Error(`Product not found: ${item.product}`);
        }
        let itemPrice = 0;
        let itemWeight = 0;
        const parsedVariantWeight = (0, exports.parseWeightFromVolume)(item.size || '');
        let variant = null;
        if (item.variantId && product.variants && product.variants.length > 0) {
            variant = product.variants.find((v) => v._id && v._id.toString() === item.variantId?.toString());
        }
        if (!variant && item.size && product.variants && product.variants.length > 0) {
            variant = product.variants.find((v) => v.volume.toLowerCase() === item.size?.toLowerCase());
        }
        if (variant) {
            itemPrice = variant.offerPrice || variant.price || 0;
            itemWeight = (variant.weight && variant.weight > 0) ? variant.weight : (parsedVariantWeight || product.weight || 0);
        }
        else if (product.variants && product.variants.length > 0) {
            const defaultVariant = product.variants[0];
            itemPrice = defaultVariant.offerPrice || defaultVariant.price || 0;
            const parsedDefaultWeight = (0, exports.parseWeightFromVolume)(defaultVariant.volume || '');
            itemWeight = (defaultVariant.weight && defaultVariant.weight > 0) ? defaultVariant.weight : (parsedDefaultWeight || product.weight || 0);
        }
        else {
            throw new Error(`Product ${product.name} has no variants configured`);
        }
        subtotal += itemPrice * item.quantity;
        totalWeight += itemWeight * item.quantity;
    }
    let baseShipping = 0;
    let extraWeightCharge = 0;
    let shipping = 0;
    let grandTotal = 0;
    const roundedWeight = Math.round(totalWeight * 1000) / 1000;
    if (subtotal > 0) {
        if (roundedWeight <= WEIGHT_THRESHOLD_KG) {
            baseShipping = SHIPPING_BELOW_THRESHOLD;
        }
        else {
            baseShipping = SHIPPING_ABOVE_THRESHOLD;
        }
        // Weight exceeding BASE_WEIGHT_KG
        const extraWeight = Math.max(roundedWeight - BASE_WEIGHT_KG, 0);
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
exports.calculateShippingForItems = calculateShippingForItems;
/**
 * Pure function for running unit tests without hitting database
 */
const calculateShippingPure = (items, config = {
    WEIGHT_THRESHOLD_KG: 0.5,
    SHIPPING_BELOW_THRESHOLD: 40,
    SHIPPING_ABOVE_THRESHOLD: 80,
    BASE_WEIGHT_KG: 1,
    EXTRA_SHIPPING_PER_KG: 20
}) => {
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
    const roundedWeight = Math.round(totalWeight * 1000) / 1000;
    if (subtotal > 0) {
        if (roundedWeight <= config.WEIGHT_THRESHOLD_KG) {
            baseShipping = config.SHIPPING_BELOW_THRESHOLD;
        }
        else {
            baseShipping = config.SHIPPING_ABOVE_THRESHOLD;
        }
        const extraWeight = Math.max(roundedWeight - config.BASE_WEIGHT_KG, 0);
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
exports.calculateShippingPure = calculateShippingPure;
//# sourceMappingURL=shippingCalculator.js.map