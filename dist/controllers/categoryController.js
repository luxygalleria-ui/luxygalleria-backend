"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteCategory = exports.updateCategory = exports.getCategories = exports.createCategory = void 0;
const Category_1 = require("../models/Category");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
exports.createCategory = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (req.file) {
        req.body.image = req.file.path;
    }
    const category = await Category_1.Category.create(req.body);
    (0, responseHandler_1.successResponse)(res, 201, 'Category created successfully', category);
});
exports.getCategories = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const categories = await Category_1.Category.find().sort({ displayOrder: 1, createdAt: -1 });
    (0, responseHandler_1.successResponse)(res, 200, 'Categories fetched successfully', categories);
});
exports.updateCategory = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    let category = await Category_1.Category.findById(req.params.id);
    if (!category) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Category not found');
    }
    if (req.file) {
        req.body.image = req.file.path;
    }
    category = await Category_1.Category.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    (0, responseHandler_1.successResponse)(res, 200, 'Category updated successfully', category);
});
exports.deleteCategory = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const category = await Category_1.Category.findByIdAndDelete(req.params.id);
    if (!category) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Category not found');
    }
    (0, responseHandler_1.successResponse)(res, 200, 'Category deleted successfully', null);
});
//# sourceMappingURL=categoryController.js.map