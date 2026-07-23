"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearCart = exports.removeFromCart = exports.updateCartItem = exports.addToCart = exports.getCart = void 0;
const Cart_1 = require("../models/Cart");
const Product_1 = require("../models/Product");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
const repairCart = async (cart) => {
    if (!cart || !cart.items || cart.items.length === 0)
        return;
    let modified = false;
    const cleanedItems = [];
    for (let item of cart.items) {
        if (!item.variantId) {
            const prod = await Product_1.Product.findById(item.product);
            if (prod && prod.variants && prod.variants.length > 0) {
                const match = prod.variants.find((v) => (v.volume || v.size || '').toLowerCase() === (item.size || '').toLowerCase());
                item.variantId = match ? match._id : prod.variants[0]._id;
                cleanedItems.push(item);
                modified = true;
            }
            // If product has no variants or doesn't exist, omit it
        }
        else {
            cleanedItems.push(item);
        }
    }
    if (modified) {
        cart.items = cleanedItems;
        await cart.save();
    }
};
// Get Cart
exports.getCart = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    let cart = await Cart_1.Cart.findOne({ user: req.user?._id });
    if (!cart) {
        cart = await Cart_1.Cart.create({ user: req.user?._id, items: [] });
    }
    else {
        await repairCart(cart);
        await cart.populate('items.product');
    }
    return (0, responseHandler_1.successResponse)(res, 200, 'Cart fetched successfully', cart);
});
// Add Item to Cart
exports.addToCart = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { productId, quantity, size, variantId } = req.body;
    const product = await Product_1.Product.findById(productId);
    if (!product) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Product not found');
    }
    let cart = await Cart_1.Cart.findOne({ user: req.user?._id });
    if (!cart) {
        cart = await Cart_1.Cart.create({ user: req.user?._id, items: [] });
    }
    else {
        await repairCart(cart);
    }
    const existingItemIndex = cart.items.findIndex((item) => item.product &&
        item.product.toString() === productId &&
        (variantId ? (item.variantId && item.variantId.toString() === variantId) : (item.size === size)));
    if (existingItemIndex > -1) {
        cart.items[existingItemIndex].quantity += quantity;
    }
    else {
        // If variantId is not provided, try to find the first variant's _id
        let actualVariantId = variantId;
        if (!actualVariantId && product.variants && product.variants.length > 0) {
            const match = product.variants.find((v) => v.volume?.toLowerCase() === size?.toLowerCase());
            actualVariantId = match ? match._id : product.variants[0]._id;
        }
        cart.items.push({ product: productId, variantId: actualVariantId, quantity, size });
    }
    await cart.save();
    await cart.populate('items.product');
    return (0, responseHandler_1.successResponse)(res, 200, 'Item added to cart', cart);
});
// Update Cart Item Quantity
exports.updateCartItem = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { productId, quantity, size, variantId } = req.body;
    let cart = await Cart_1.Cart.findOne({ user: req.user?._id });
    if (!cart) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Cart not found');
    }
    await repairCart(cart);
    const existingItemIndex = cart.items.findIndex((item) => item.product &&
        item.product.toString() === productId &&
        (variantId ? (item.variantId && item.variantId.toString() === variantId) : (item.size === size)));
    if (existingItemIndex > -1) {
        if (quantity > 0) {
            cart.items[existingItemIndex].quantity = quantity;
        }
        else {
            cart.items.splice(existingItemIndex, 1);
        }
        await cart.save();
        await cart.populate('items.product');
        return (0, responseHandler_1.successResponse)(res, 200, 'Cart updated', cart);
    }
    else {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Item not found in cart');
    }
});
// Remove Item from Cart
exports.removeFromCart = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { productId, size, variantId } = req.body; // or params, but using body is easier for optional size
    let cart = await Cart_1.Cart.findOne({ user: req.user?._id });
    if (!cart) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Cart not found');
    }
    await repairCart(cart);
    cart.items = cart.items.filter((item) => !(item.product &&
        item.product.toString() === productId &&
        (variantId ? (item.variantId && item.variantId.toString() === variantId) : (item.size === size))));
    await cart.save();
    await cart.populate('items.product');
    return (0, responseHandler_1.successResponse)(res, 200, 'Item removed from cart', cart);
});
// Clear Cart
exports.clearCart = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    let cart = await Cart_1.Cart.findOne({ user: req.user?._id });
    if (cart) {
        cart.items = [];
        await cart.save();
    }
    return (0, responseHandler_1.successResponse)(res, 200, 'Cart cleared', cart);
});
//# sourceMappingURL=cartController.js.map