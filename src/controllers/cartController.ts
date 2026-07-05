import { Request, Response } from 'express';
import { Cart } from '../models/Cart';
import { Product } from '../models/Product';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

// Get Cart
export const getCart = asyncHandler(async (req: Request, res: Response) => {
  let cart = await Cart.findOne({ user: req.user?._id }).populate('items.product');
  if (!cart) {
    cart = await Cart.create({ user: req.user?._id, items: [] });
  }
  return successResponse(res, 200, 'Cart fetched successfully', cart);
});

// Add Item to Cart
export const addToCart = asyncHandler(async (req: Request, res: Response) => {
  const { productId, quantity, size } = req.body;
  
  const product = await Product.findById(productId);
  if (!product) {
    return errorResponse(res, 404, 'Product not found');
  }

  let cart = await Cart.findOne({ user: req.user?._id });
  if (!cart) {
    cart = await Cart.create({ user: req.user?._id, items: [] });
  }

  const existingItemIndex = cart.items.findIndex(
    (item) => item.product && item.product.toString() === productId && item.size === size
  );

  if (existingItemIndex > -1) {
    cart.items[existingItemIndex].quantity += quantity;
  } else {
    cart.items.push({ product: productId, quantity, size });
  }

  await cart.save();
  await cart.populate('items.product');

  return successResponse(res, 200, 'Item added to cart', cart);
});

// Update Cart Item Quantity
export const updateCartItem = asyncHandler(async (req: Request, res: Response) => {
  const { productId, quantity, size } = req.body;

  let cart = await Cart.findOne({ user: req.user?._id });
  if (!cart) {
    return errorResponse(res, 404, 'Cart not found');
  }

  const existingItemIndex = cart.items.findIndex(
    (item) => item.product && item.product.toString() === productId && item.size === size
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
  const { productId, size } = req.body; // or params, but using body is easier for optional size

  let cart = await Cart.findOne({ user: req.user?._id });
  if (!cart) {
    return errorResponse(res, 404, 'Cart not found');
  }

  cart.items = cart.items.filter(
    (item) => !(item.product && item.product.toString() === productId && item.size === size)
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
