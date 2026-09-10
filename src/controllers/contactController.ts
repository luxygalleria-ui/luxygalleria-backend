import { Request, Response } from 'express';
import { Contact, CONTACT_STATUSES, ContactStatus } from '../models/Contact';
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

  // Only ever trust these five fields off the wire — status is server-owned.
  const contact = await Contact.create({
    name,
    email,
    phone,
    subject,
    message
  });

  successResponse(res, 201, 'Message sent successfully', contact);
});

/** Escape regex metacharacters so a search for "a+b" is a literal, not a pattern. */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type ContactQueryResult =
  | { ok: true; query: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Translates the admin list filters into a Mongo query.
 * An absent status, or "ALL", means no status constraint.
 */
export function buildContactQuery(rawStatus?: string, rawSearch?: string): ContactQueryResult {
  const query: Record<string, unknown> = {};

  const status = rawStatus?.trim().toUpperCase();
  if (status && status !== 'ALL') {
    if (!CONTACT_STATUSES.includes(status as ContactStatus)) {
      return { ok: false, message: `status must be one of: ${CONTACT_STATUSES.join(', ')}` };
    }
    query.status = status;
  }

  const search = rawSearch?.trim();
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    query.$or = [{ name: rx }, { email: rx }, { subject: rx }, { message: rx }];
  }

  return { ok: true, query };
}

// @desc    Get all contacts, newest first. Optional ?status= and ?search= filters.
// @route   GET /api/v1/contacts
// @access  Private/Admin
export const getContacts = asyncHandler(async (req: Request, res: Response) => {
  // Backfill messages stored before `status` replaced the old `isRead` flag.
  // Matches nothing once migrated, so it costs one indexed no-op lookup.
  // ponytail: read-path backfill; move to a migration script if this collection grows.
  await Contact.collection.updateMany(
    { status: { $exists: false } },
    [{ $set: { status: { $cond: ['$isRead', 'READ', 'NEW'] } } }] as any
  );

  const built = buildContactQuery(req.query.status?.toString(), req.query.search?.toString());
  if (!built.ok) {
    return errorResponse(res, 400, built.message);
  }

  const contacts = await Contact.find(built.query).sort({ createdAt: -1 });
  successResponse(res, 200, 'Contacts fetched successfully', contacts);
});

// @desc    Update a contact's status (NEW / READ / RESOLVED)
// @route   PUT /api/v1/contacts/:id/status
// @access  Private/Admin
export const updateContactStatus = asyncHandler(async (req: Request, res: Response) => {
  const status = req.body.status?.toString().toUpperCase();

  if (!CONTACT_STATUSES.includes(status as ContactStatus)) {
    return errorResponse(res, 400, `status must be one of: ${CONTACT_STATUSES.join(', ')}`);
  }

  const contact = await Contact.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true, runValidators: true }
  );

  if (!contact) {
    return errorResponse(res, 404, 'Contact not found');
  }

  successResponse(res, 200, 'Contact status updated', contact);
});

// @desc    Mark contact as read (kept for the existing PUT /:id/read route)
// @route   PUT /api/v1/contacts/:id/read
// @access  Private/Admin
export const markContactAsRead = asyncHandler(async (req: Request, res: Response) => {
  const contact = await Contact.findByIdAndUpdate(
    req.params.id,
    { status: 'READ' },
    { new: true }
  );

  if (!contact) {
    return errorResponse(res, 404, 'Contact not found');
  }

  successResponse(res, 200, 'Contact marked as read', contact);
});

// @desc    Delete contact
// @route   DELETE /api/v1/contacts/:id
// @access  Private/Admin
export const deleteContact = asyncHandler(async (req: Request, res: Response) => {
  const contact = await Contact.findByIdAndDelete(req.params.id);

  if (!contact) {
    return errorResponse(res, 404, 'Contact not found');
  }

  successResponse(res, 200, 'Contact deleted successfully', {});
});
