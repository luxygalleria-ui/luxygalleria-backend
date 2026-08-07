"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteBrand = exports.updateBrand = exports.getBrands = exports.createBrand = void 0;
const Brand_1 = require("../models/Brand");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
exports.createBrand = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (req.file) {
        req.body.logo = req.file.path;
    }
    const brand = await Brand_1.Brand.create(req.body);
    (0, responseHandler_1.successResponse)(res, 201, 'Brand created successfully', brand);
});
exports.getBrands = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const brands = await Brand_1.Brand.find().sort({ displayOrder: 1, createdAt: -1 });
    (0, responseHandler_1.successResponse)(res, 200, 'Brands fetched successfully', brands);
});
exports.updateBrand = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    let brand = await Brand_1.Brand.findById(req.params.id);
    if (!brand) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Brand not found');
    }
    if (req.file) {
        req.body.logo = req.file.path;
    }
    brand = await Brand_1.Brand.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    (0, responseHandler_1.successResponse)(res, 200, 'Brand updated successfully', brand);
});
exports.deleteBrand = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const brand = await Brand_1.Brand.findByIdAndDelete(req.params.id);
    if (!brand) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Brand not found');
    }
    (0, responseHandler_1.successResponse)(res, 200, 'Brand deleted successfully', null);
});
//# sourceMappingURL=brandController.js.map