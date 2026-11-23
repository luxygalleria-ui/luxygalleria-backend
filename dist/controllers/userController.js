"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toggleCustomerStatus = exports.getAllCustomers = exports.editAddress = exports.deleteCustomer = exports.deleteAddress = exports.addAddress = exports.updateProfile = exports.getAddresses = exports.getProfile = void 0;
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
const addressRules_1 = require("../utils/addressRules");
exports.getProfile = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const user = await User_1.User.findById(req.user?._id).select('-password');
    if (!user)
        return (0, responseHandler_1.errorResponse)(res, 404, 'User not found');
    const userData = {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        avatar: user.avatar,
        googleLinked: !!user.googleId // whether Google sign-in is linked (never the id itself)
    };
    (0, responseHandler_1.successResponse)(res, 200, 'Profile fetched successfully', userData);
});
exports.getAddresses = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const user = await User_1.User.findById(req.user?._id);
    if (!user)
        return (0, responseHandler_1.errorResponse)(res, 404, 'User not found');
    (0, responseHandler_1.successResponse)(res, 200, 'Addresses fetched successfully', user.addresses || []);
});
exports.updateProfile = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { name, phone } = req.body;
    const updatedFields = {};
    if (name)
        updatedFields.name = name;
    if (phone !== undefined)
        updatedFields.phone = phone;
    const user = await User_1.User.findByIdAndUpdate(req.user?._id, { $set: updatedFields }, { new: true, runValidators: true });
    if (!user)
        return (0, responseHandler_1.errorResponse)(res, 404, 'User not found');
    const updatedUser = {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        avatar: user.avatar,
        googleLinked: !!user.googleId // whether Google sign-in is linked (never the id itself)
    };
    (0, responseHandler_1.successResponse)(res, 200, 'Profile updated successfully', updatedUser);
});
exports.addAddress = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const user = await User_1.User.findById(req.user?._id);
    if (!user)
        return (0, responseHandler_1.errorResponse)(res, 404, 'User not found');
    if (!user.addresses) {
        user.addresses = [];
    }
    const { street, apartment, landmark, city, state, zipCode, country } = req.body;
    if (!city || !state) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'City and State are required');
    }
    // PIN format and the Kerala PIN/state boundary (delivery is priced by state); nothing is changed for the customer
    const problem = (0, addressRules_1.addressProblem)({ state, zipCode, country });
    if (problem)
        return (0, responseHandler_1.errorResponse)(res, 400, problem);
    if (user.addresses.some((a) => (0, addressRules_1.addressKey)(a) === (0, addressRules_1.addressKey)({ street, apartment, city, state, zipCode, country }))) {
        return (0, responseHandler_1.errorResponse)(res, 409, 'This address is already saved. Choose it from your saved addresses.');
    }
    user.addresses.push({ street, apartment, landmark, city, state, zipCode, country });
    await user.save();
    (0, responseHandler_1.successResponse)(res, 201, 'Address added successfully', user.addresses);
});
// Delete Address
exports.deleteAddress = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { addressId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(String(addressId)))
        return (0, responseHandler_1.errorResponse)(res, 400, 'Invalid address id');
    const user = await User_1.User.findById(req.user?._id);
    if (!user)
        return (0, responseHandler_1.errorResponse)(res, 404, 'User not found');
    user.addresses = (user.addresses || []).filter((addr) => addr._id?.toString() !== addressId);
    await user.save();
    (0, responseHandler_1.successResponse)(res, 200, 'Address removed successfully', user.addresses);
});
// Delete Customer (Admin only)
exports.deleteCustomer = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = req.params;
    const customer = await User_1.User.findById(id);
    if (!customer) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Customer not found');
    }
    // Prevent deleting admin users
    if (customer.role === 'admin' || customer.role === 'superadmin') {
        return (0, responseHandler_1.errorResponse)(res, 403, 'Cannot delete admin users');
    }
    await User_1.User.findByIdAndDelete(id);
    (0, responseHandler_1.successResponse)(res, 200, 'Customer deleted successfully', null);
});
// Edit Address
exports.editAddress = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const user = await User_1.User.findById(req.user?._id);
    if (!user)
        return (0, responseHandler_1.errorResponse)(res, 404, 'User not found');
    const { addressId } = req.params;
    const addressIndex = user.addresses?.findIndex((addr) => addr._id?.toString() === addressId);
    if (addressIndex === undefined || addressIndex === -1) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Address not found');
    }
    const { street, apartment, landmark, city, state, zipCode, country } = req.body;
    if (!city || !state) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'City and State are required');
    }
    const problem = (0, addressRules_1.addressProblem)({ state, zipCode, country });
    if (problem)
        return (0, responseHandler_1.errorResponse)(res, 400, problem);
    if (user.addresses?.some((a, i) => i !== addressIndex && (0, addressRules_1.addressKey)(a) === (0, addressRules_1.addressKey)({ street, apartment, city, state, zipCode, country }))) {
        return (0, responseHandler_1.errorResponse)(res, 409, 'Another saved address is already exactly this one.');
    }
    // Update the saved entry in place: replacing it with a copied object dropped its _id, so every edit gave the
    // address a new id and a checkout still holding the old one was told the address "no longer exists"
    user.addresses[addressIndex].set({ street, apartment, landmark, city, state, zipCode, country });
    await user.save();
    (0, responseHandler_1.successResponse)(res, 200, 'Address updated successfully', user.addresses);
});
// Admin: Get all customers
exports.getAllCustomers = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const customers = await User_1.User.find({ role: 'customer' })
        .select('name email phone isActive createdAt')
        .sort({ createdAt: -1 });
    (0, responseHandler_1.successResponse)(res, 200, 'Customers fetched successfully', customers);
});
// Admin: Toggle customer active status (block/unblock)
exports.toggleCustomerStatus = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = req.params;
    const user = await User_1.User.findById(id);
    if (!user || user.role !== 'customer')
        return (0, responseHandler_1.errorResponse)(res, 404, 'Customer not found');
    user.isActive = !user.isActive;
    await user.save();
    (0, responseHandler_1.successResponse)(res, 200, `Customer ${user.isActive ? 'unblocked' : 'blocked'} successfully`, user);
});
//# sourceMappingURL=userController.js.map