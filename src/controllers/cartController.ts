import { Request, Response } from 'express';
import { Cart } from '../models/Cart';
import { Product } from '../models/Product';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

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

// Add Item to Cart
export const addToCart = asyncHandler(async (req: Request, res: Response) => {
  const { productId, quantity, size, variantId } = req.body;
  
  const product = await Product.findById(productId);
  if (!product) {
    return errorResponse(res, 404, 'Product not found');
  }

  let cart = await Cart.findOne({ user: req.user?._id });
  if (!cart) {
    cart = await Cart.create({ user: req.user?._id, items: [] });
  } else {
    await repairCart(cart);
  }

  const existingItemIndex = cart.items.findIndex(
    (item) =>
      item.product &&
      item.product.toString() === productId &&
      (variantId ? (item.variantId && item.variantId.toString() === variantId) : (item.size === size))
  );

  if (existingItemIndex > -1) {
    cart.items[existingItemIndex].quantity += quantity;
  } else {
    // If variantId is not provided, try to find the first variant's _id
    let actualVariantId = variantId;
    if (!actualVariantId && product.variants && product.variants.length > 0) {
      const match = product.variants.find((v: any) => v.volume?.toLowerCase() === size?.toLowerCase());
      actualVariantId = match ? match._id : product.variants[0]._id;
    }
    cart.items.push({ product: productId, variantId: actualVariantId, quantity, size });
  }

  await cart.save();
  await cart.populate('items.product');

  return successResponse(res, 200, 'Item added to cart', cart);
});

// Update Cart Item Quantity
export const updateCartItem = asyncHandler(async (req: Request, res: Response) => {
  const { productId, quantity, size, variantId } = req.body;

  let cart = await Cart.findOne({ user: req.user?._id });
  if (!cart) {
    return errorResponse(res, 404, 'Cart not found');
  }
  await repairCart(cart);

  const existingItemIndex = cart.items.findIndex(
    (item) =>
      item.product &&
      item.product.toString() === productId &&
      (variantId ? (item.variantId && item.variantId.toString() === variantId) : (item.size === size))
  );

  if (existingItemIndex > -1) {
    if (quantity > 0) {
      cart.items[existingItemIndex].quantity = quantity;
    } else {
      cart.items.splice(existingItemIndex, 1);
    }
    await cart.save();
    await cart.populate('items.product');
    return successResponse(res, 200, 'Cart updated', cart);
  } else {
    return errorResponse(res, 404, 'Item not found in cart');
  }
});

// Remove Item from Cart
export const removeFromCart = asyncHandler(async (req: Request, res: Response) => {
  const { productId, size, variantId } = req.body; // or params, but using body is easier for optional size

  let cart = await Cart.findOne({ user: req.user?._id });
  if (!cart) {
    return errorResponse(res, 404, 'Cart not found');
  }
  await repairCart(cart);

  cart.items = cart.items.filter(
    (item) =>
      !(
        item.product &&
        item.product.toString() === productId &&
        (variantId ? (item.variantId && item.variantId.toString() === variantId) : (item.size === size))
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
