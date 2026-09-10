"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteContact = exports.markContactAsRead = exports.updateContactStatus = exports.getContacts = exports.escapeRegex = exports.submitContactForm = void 0;
exports.buildContactQuery = buildContactQuery;
const Contact_1 = require("../models/Contact");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
// @desc    Submit a contact form
// @route   POST /api/v1/contacts
// @access  Public
exports.submitContactForm = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { name, email, phone, subject, message } = req.body;
    if (!name || !email || !message) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Please provide name, email and message');
    }
    // Only ever trust these five fields off the wire — status is server-owned.
    const contact = await Contact_1.Contact.create({
        name,
        email,
        phone,
        subject,
        message
    });
    (0, responseHandler_1.successResponse)(res, 201, 'Message sent successfully', contact);
});
/** Escape regex metacharacters so a search for "a+b" is a literal, not a pattern. */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
exports.escapeRegex = escapeRegex;
/**
 * Translates the admin list filters into a Mongo query.
 * An absent status, or "ALL", means no status constraint.
 */
function buildContactQuery(rawStatus, rawSearch) {
    const query = {};
    const status = rawStatus?.trim().toUpperCase();
    if (status && status !== 'ALL') {
        if (!Contact_1.CONTACT_STATUSES.includes(status)) {
            return { ok: false, message: `status must be one of: ${Contact_1.CONTACT_STATUSES.join(', ')}` };
        }
        query.status = status;
    }
    const search = rawSearch?.trim();
    if (search) {
        const rx = { $regex: (0, exports.escapeRegex)(search), $options: 'i' };
        query.$or = [{ name: rx }, { email: rx }, { subject: rx }, { message: rx }];
    }
    return { ok: true, query };
}
// @desc    Get all contacts, newest first. Optional ?status= and ?search= filters.
// @route   GET /api/v1/contacts
// @access  Private/Admin
exports.getContacts = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    // Backfill messages stored before `status` replaced the old `isRead` flag.
    // Matches nothing once migrated, so it costs one indexed no-op lookup.
    // ponytail: read-path backfill; move to a migration script if this collection grows.
    await Contact_1.Contact.collection.updateMany({ status: { $exists: false } }, [{ $set: { status: { $cond: ['$isRead', 'READ', 'NEW'] } } }]);
    const built = buildContactQuery(req.query.status?.toString(), req.query.search?.toString());
    if (!built.ok) {
        return (0, responseHandler_1.errorResponse)(res, 400, built.message);
    }
    const contacts = await Contact_1.Contact.find(built.query).sort({ createdAt: -1 });
    (0, responseHandler_1.successResponse)(res, 200, 'Contacts fetched successfully', contacts);
});
// @desc    Update a contact's status (NEW / READ / RESOLVED)
// @route   PUT /api/v1/contacts/:id/status
// @access  Private/Admin
exports.updateContactStatus = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const status = req.body.status?.toString().toUpperCase();
    if (!Contact_1.CONTACT_STATUSES.includes(status)) {
        return (0, responseHandler_1.errorResponse)(res, 400, `status must be one of: ${Contact_1.CONTACT_STATUSES.join(', ')}`);
    }
    const contact = await Contact_1.Contact.findByIdAndUpdate(req.params.id, { status }, { new: true, runValidators: true });
    if (!contact) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Contact not found');
    }
    (0, responseHandler_1.successResponse)(res, 200, 'Contact status updated', contact);
});
// @desc    Mark contact as read (kept for the existing PUT /:id/read route)
// @route   PUT /api/v1/contacts/:id/read
// @access  Private/Admin
exports.markContactAsRead = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const contact = await Contact_1.Contact.findByIdAndUpdate(req.params.id, { status: 'READ' }, { new: true });
    if (!contact) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Contact not found');
    }
    (0, responseHandler_1.successResponse)(res, 200, 'Contact marked as read', contact);
});
// @desc    Delete contact
// @route   DELETE /api/v1/contacts/:id
// @access  Private/Admin
exports.deleteContact = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const contact = await Contact_1.Contact.findByIdAndDelete(req.params.id);
    if (!contact) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'Contact not found');
    }
    (0, responseHandler_1.successResponse)(res, 200, 'Contact deleted successfully', {});
});
//# sourceMappingURL=contactController.js.map