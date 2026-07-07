"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteProduct = exports.updateProduct = exports.getProducts = exports.createProduct = void 0;
const Product_1 = require("../models/Product");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
const shippingCalculator_1 = require("../utils/shippingCalculator");
exports.createProduct = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (req.files && Array.isArray(req.files)) {
        const fileUrls = req.files.map(file => file.path);
        // Parse the stringified arrays/objects from formData if necessary
        if (typeof req.body.images === 'string') {
            req.body.images = [req.body.images];
        }
        req.body.images = [...(req.body.images || []), ...fileUrls];
    }
    // Handle variants parsing if sent as a string (from FormData)
    if (typeof req.body.variants === 'string') {
        try {
            req.body.variants = JSON.parse(req.body.variants);
        }
        catch (e) {
            // do nothing, let validator catch it
        }
    }
    if (req.body.variants && Array.isArray(req.body.variants)) {
        req.body.variants = req.body.variants.map((v) => {
            const parsedWeight = (0, shippingCalculator_1.parseWeightFromVolume)(v.volume || '');
            const offerPrice = Number(v.offerPrice !== undefined ? v.offerPrice : (v.price || 0));
            const actualPrice = Number(v.actualPrice !== undefined ? v.actualPrice : (v.oldPrice || v.price || 0));
            const weight = Number(v.weight !== undefined ? v.weight : (parsedWeight !== null ? parsedWeight : 0));
            const stock = Number(v.stock !== undefined ? v.stock : 0);
            const sku = v.sku || '';
            const image = v.image || '';
            const images = Array.isArray(v.images) ? v.images : (v.image ? [v.image] : []);
            return {
                ...v,
                offerPrice,
                actualPrice,
                price: offerPrice,
                oldPrice: actualPrice,
                weight,
                stock,
                image,
                images,
                sku
            };
        });
        if (req.body.variants.length > 0) {
            req.body.weight = req.body.variants[0].weight;
            req.body.stock = req.body.variants.reduce((acc, curr) => acc + curr.stock, 0);
        }
    }
    const product = await Product_1.Product.create(req.body);
    (0, responseHandler_1.successResponse)(res, 201, 'Product created successfully', product);
});
exports.getProducts = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const products = await Product_1.Product.find().sort({ createdAt: -1 });
    (0, responseHandler_1.successResponse)(res, 200, 'Products fetched successfully', products);
});
exports.updateProduct = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    let product = await Product_1.Product.findById(req.params.id);
    if (!product) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Product not found');
    }
    if (req.files && Array.isArray(req.files)) {
        const fileUrls = req.files.map(file => file.path);
        if (typeof req.body.images === 'string') {
            req.body.images = [req.body.images];
        }
        req.body.images = [...(req.body.images || []), ...fileUrls];
    }
    if (typeof req.body.variants === 'string') {
        try {
            req.body.variants = JSON.parse(req.body.variants);
        }
        catch (e) {
            // do nothing
        }
    }
    if (req.body.variants && Array.isArray(req.body.variants)) {
        req.body.variants = req.body.variants.map((v) => {
            const parsedWeight = (0, shippingCalculator_1.parseWeightFromVolume)(v.volume || '');
            const offerPrice = Number(v.offerPrice !== undefined ? v.offerPrice : (v.price || 0));
            const actualPrice = Number(v.actualPrice !== undefined ? v.actualPrice : (v.oldPrice || v.price || 0));
            const weight = Number(v.weight !== undefined ? v.weight : (parsedWeight !== null ? parsedWeight : 0));
            const stock = Number(v.stock !== undefined ? v.stock : 0);
            const sku = v.sku || '';
            const image = v.image || '';
            const images = Array.isArray(v.images) ? v.images : (v.image ? [v.image] : []);
            return {
                ...v,
                offerPrice,
                actualPrice,
                price: offerPrice,
                oldPrice: actualPrice,
                weight,
                stock,
                image,
                images,
                sku
            };
        });
        if (req.body.variants.length > 0) {
            req.body.weight = req.body.variants[0].weight;
            req.body.stock = req.body.variants.reduce((acc, curr) => acc + curr.stock, 0);
        }
    }
    product = await Product_1.Product.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
    });
    (0, responseHandler_1.successResponse)(res, 200, 'Product updated successfully', product);
});
exports.deleteProduct = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const product = await Product_1.Product.findByIdAndDelete(req.params.id);
    if (!product) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Product not found');
    }
    (0, responseHandler_1.successResponse)(res, 200, 'Product deleted successfully', null);
});
//# sourceMappingURL=productController.js.map