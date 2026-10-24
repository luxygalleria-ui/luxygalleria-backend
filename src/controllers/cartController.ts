import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Cart } from '../models/Cart';
import { Product } from '../models/Product';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { MAX_QTY_PER_LINE } from '../utils/shippingCalculator';

const repairCart = async (cart: any) => {
  if (!cart || !cart.items || cart.items.length === 0) return;
  let modified = false;
  const cleanedItems = [];
  for (let item of cart.items) {
    if (!item.variantId) {
      const prod = await Product.findById(item.product);
      if (prod && prod.variants && prod.variants.length > 0) {
        const match = prod.variants.find((v: any) => (v.volume || v.size || '').toLowerCase() === (item.size || '').toLowerCase());
        item.variantId = match ? match._id : prod.variants[0]._id;
        cleanedItems.push(item);
        modified = true;
      }
      // If product has no variants or doesn't exist, omit it
    } else {
      cleanedItems.push(item);
    }
  }
  if (modified) {
    cart.items = cleanedItems;
    await cart.save();
  }
};

// Get Cart
export const getCart = asyncHandler(async (req: Request, res: Response) => {
  let cart = await Cart.findOne({ user: req.user?._id });
  if (!cart) {
    cart = await Cart.create({ user: req.user?._id, items: [] });
  } else {
    await repairCart(cart);
    await cart.populate('items.product');
  }
  return successResponse(res, 200, 'Cart fetched successfully', cart);
});

/**
 * Resolves and validates a cart line from the request: the product must exist, the variant must belong to it
 * (by id, else by size, else the first variant) and the quantity must be a whole number within the per-line limit.
 * Returns an error tuple instead of throwing so a bad id is a 400, never a 500.
 */
const resolveLine = async (body: any, { allowZero = false } = {}) => {
  const { productId, variantId, size } = body || {};
  const quantity = body?.quantity;
  if (!mongoose.isValidObjectId(productId)) return { error: [400, 'Invalid product id'] as const };
  if (variantId !== undefined && variantId !== null && variantId !== '' && !mongoose.isValidObjectId(variantId)) return { error: [400, 'Invalid variant id'] as const };
  if (!Number.isInteger(quantity) || quantity < (allowZero ? 0 : 1) || quantity > MAX_QTY_PER_LINE) {
    return { error: [400, `Quantity must be a whole number between ${allowZero ? 0 : 1} and ${MAX_QTY_PER_LINE}`] as const };
  }
  const product = await Product.findById(productId);
  if (!product) return { error: [404, 'Product not found'] as const };
  const variants: any[] = product.variants || [];
  const variant = variantId
    ? variants.find((v) => String(v._id) === String(variantId))
    : variants.find((v) => (v.volume || '').toLowerCase() === String(size || '').toLowerCase()) || variants[0];
  if (!variant) return { error: [variantId ? 404 : 400, variantId ? 'This option is no longer available' : 'Product has no options configured'] as const };
  return { product, variant, quantity: quantity as number, size: typeof size === 'string' ? size : variant.volume };
};

const sameLine = (item: any, productId: string, variantId: string) =>
  item.product && item.product.toString() === String(productId) && item.variantId && item.variantId.toString() === String(variantId);

/** The cart for the request's user, created when missing (a new account has none yet). */
const cartOf = async (req: Request) => {
  const cart = (await Cart.findOne({ user: req.user?._id })) ?? (await Cart.create({ user: req.user?._id, items: [] }));
  await repairCart(cart);
  return cart;
};

const stockError = (res: Response, name: string, stock: number) =>
  errorResponse(res, 409, stock > 0 ? `Only ${stock} of ${name} left in stock` : `${name} is out of stock`, [{ code: 'INSUFFICIENT_STOCK', available: Math.max(0, stock) }]);

// Add Item to Cart (adds to the line's quantity)
export const addToCart = asyncHandler(async (req: Request, res: Response) => {
  const line = await resolveLine(req.body);
  if ('error' in line) return errorResponse(res, line.error![0], line.error![1]);
  const { product, variant, quantity, size } = line;

  const cart = await cartOf(req);
  const existing = cart.items.find((item) => sameLine(item, product._id.toString(), variant._id.toString()));
  const next = (existing?.quantity || 0) + quantity;
  if (next > MAX_QTY_PER_LINE) return errorResponse(res, 400, `At most ${MAX_QTY_PER_LINE} of one item per order`);
  if (next > (Number(variant.stock) || 0)) return stockError(res, product.name, Number(variant.stock) || 0);

  if (existing) existing.quantity = next;
  else cart.items.push({ product: product._id, variantId: variant._id, quantity, size });

  await cart.save();
  await cart.populate('items.product');
  return successResponse(res, 200, 'Item added to cart', cart);
});

// Set a line's quantity: adds the line when missing (a cart built before sign-in), removes it at 0
export const updateCartItem = asyncHandler(async (req: Request, res: Response) => {
  const line = await resolveLine(req.body, { allowZero: true });
  if ('error' in line) return errorResponse(res, line.error![0], line.error![1]);
  const { product, variant, quantity, size } = line;

  const cart = await cartOf(req);
  const index = cart.items.findIndex((item) => sameLine(item, product._id.toString(), variant._id.toString()));
  if (quantity === 0) {
    if (index > -1) cart.items.splice(index, 1);
  } else {
    if (quantity > (Number(variant.stock) || 0)) return stockError(res, product.name, Number(variant.stock) || 0);
    if (index > -1) cart.items[index].quantity = quantity;
    else cart.items.push({ product: product._id, variantId: variant._id, quantity, size });
  }

  await cart.save();
  await cart.populate('items.product');
  return successResponse(res, 200, 'Cart updated', cart);
});

// Remove Item from Cart. Idempotent: removing a line that is not there succeeds.
export const removeFromCart = asyncHandler(async (req: Request, res: Response) => {
  const { productId, size, variantId } = req.body || {};
  if (!mongoose.isValidObjectId(productId)) return errorResponse(res, 400, 'Invalid product id');

  const cart = await Cart.findOne({ user: req.user?._id });
  if (!cart) return successResponse(res, 200, 'Item removed from cart', { items: [] });
  await repairCart(cart);

  cart.items = cart.items.filter(
    (item) =>
      !(
        item.product &&
        item.product.toString() === String(productId) &&
        (variantId ? (item.variantId && item.variantId.toString() === String(variantId)) : (item.size === size))
      )
  );

  await cart.save();
  await cart.populate('items.product');

  return successResponse(res, 200, 'Item removed from cart', cart);
});

// Clear Cart
export const clearCart = asyncHandler(async (req: Request, res: Response) => {
  let cart = await Cart.findOne({ user: req.user?._id });
  if (cart) {
    cart.items = [];
    await cart.save();
  }
  return successResponse(res, 200, 'Cart cleared', cart);
});
