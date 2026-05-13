import { Request, Response } from 'express';
import { Contact } from '../models/Contact';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';

// @desc    Submit a contact form
// @route   POST /api/v1/contacts
// @access  Public
export const submitContactForm = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, phone, subject, message } = req.body;

  if (!name || !email || !message) {
    return errorResponse(res, 400, 'Please provide name, email and message');
  }

  const contact = await Contact.create({
    name,
    email,
    phone,
    subject,
    message
  });

  successResponse(res, 201, 'Message sent successfully', contact);
});

// @desc    Get all contacts
// @route   GET /api/v1/contacts
// @access  Private/Admin
export const getContacts = asyncHandler(async (req: Request, res: Response) => {
  const contacts = await Contact.find().sort({ createdAt: -1 });
  successResponse(res, 200, 'Contacts fetched successfully', contacts);
});

// @desc    Mark contact as read
// @route   PUT /api/v1/contacts/:id/read
// @access  Private/Admin
export const markContactAsRead = asyncHandler(async (req: Request, res: Response) => {
  const contact = await Contact.findById(req.params.id);

  if (!contact) {
    return errorResponse(res, 404, 'Contact not found');
  }

  contact.isRead = true;
  await contact.save();

  successResponse(res, 200, 'Contact marked as read', contact);
});

// @desc    Delete contact
// @route   DELETE /api/v1/contacts/:id
// @access  Private/Admin
export const deleteContact = asyncHandler(async (req: Request, res: Response) => {
  const contact = await Contact.findById(req.params.id);

  if (!contact) {
    return errorResponse(res, 404, 'Contact not found');
  }

  await contact.deleteOne();

  successResponse(res, 200, 'Contact deleted successfully', {});
});
