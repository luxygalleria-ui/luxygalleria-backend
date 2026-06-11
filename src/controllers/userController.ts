import { Request, Response } from 'express';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.user?._id).select('-password');
  if (!user) return errorResponse(res, 404, 'User not found');
  
  const userData = {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role
  };
  
  successResponse(res, 200, 'Profile fetched successfully', userData);
});

export const getAddresses = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.user?._id);
  if (!user) return errorResponse(res, 404, 'User not found');
  
  successResponse(res, 200, 'Addresses fetched successfully', user.addresses || []);
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const { name, phone } = req.body;
  
  const updatedFields: any = {};
  if (name) updatedFields.name = name;
  if (phone !== undefined) updatedFields.phone = phone;

  const user = await User.findByIdAndUpdate(
    req.user?._id,
    { $set: updatedFields },
    { new: true, runValidators: true }
  );

  if (!user) return errorResponse(res, 404, 'User not found');

  const updatedUser = {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role
  };

  successResponse(res, 200, 'Profile updated successfully', updatedUser);
});

export const addAddress = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.user?._id);
  if (!user) return errorResponse(res, 404, 'User not found');

  if (!user.addresses) {
    user.addresses = [];
  }
  
  const { street, apartment, landmark, city, state, zipCode, country } = req.body;
  
  if (!city || !state) {
    return errorResponse(res, 400, 'City and State are required');
  }

  user.addresses.push({ street, apartment, landmark, city, state, zipCode, country });
  await user.save();
  
  successResponse(res, 201, 'Address added successfully', user.addresses);
});

// Delete Address
export const deleteAddress = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.user?._id);
  if (!user) return errorResponse(res, 404, 'User not found');

  const { addressId } = req.params;
  user.addresses = (user.addresses || []).filter(
    (addr) => addr._id?.toString() !== addressId
  );
  await user.save();

  successResponse(res, 200, 'Address removed successfully', user.addresses);
});

// Delete Customer (Admin only)
export const deleteCustomer = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  
  const customer = await User.findById(id);
  if (!customer) {
    return errorResponse(res, 404, 'Customer not found');
  }

  // Prevent deleting admin users
  if (customer.role === 'admin' || customer.role === 'superadmin') {
    return errorResponse(res, 403, 'Cannot delete admin users');
  }

  await User.findByIdAndDelete(id);
  successResponse(res, 200, 'Customer deleted successfully', null);
});

// Edit Address
export const editAddress = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.user?._id);
  if (!user) return errorResponse(res, 404, 'User not found');

  const { addressId } = req.params;
  const addressIndex = user.addresses?.findIndex(
    (addr: any) => addr._id?.toString() === addressId
  );

  if (addressIndex === undefined || addressIndex === -1) {
    return errorResponse(res, 404, 'Address not found');
  }

  const { street, apartment, landmark, city, state, zipCode, country } = req.body;
  
  if (!city || !state) {
    return errorResponse(res, 400, 'City and State are required');
  }

  if (user.addresses) {
    user.addresses[addressIndex] = {
      ...user.addresses[addressIndex],
      street,
      apartment,
      landmark,
      city,
      state,
      zipCode,
      country
    };
  }
  
  await user.save();
  successResponse(res, 200, 'Address updated successfully', user.addresses);
});

// Admin: Get all customers
export const getAllCustomers = asyncHandler(async (req: Request, res: Response) => {
  const customers = await User.find({ role: 'customer' })
    .select('name email phone isActive createdAt')
    .sort({ createdAt: -1 });
  
  successResponse(res, 200, 'Customers fetched successfully', customers);
});

// Admin: Toggle customer active status (block/unblock)
export const toggleCustomerStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  
  const user = await User.findById(id);
  if (!user) return errorResponse(res, 404, 'Customer not found');

  user.isActive = !user.isActive;
  await user.save();

  successResponse(res, 200, `Customer ${user.isActive ? 'unblocked' : 'blocked'} successfully`, user);
});
