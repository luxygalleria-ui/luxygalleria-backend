"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateCheckoutProducts = exports.listCheckoutProducts = exports.updateCheckoutSection = exports.getCheckoutSettings = exports.updateSettings = exports.getSettings = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const zod_1 = require("zod");
const Settings_1 = require("../models/Settings");
const Product_1 = require("../models/Product");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
const checkoutSettings_1 = require("../utils/checkoutSettings");
// Checkout sections are only written through their validated endpoints below, never through the general settings PUT
const NOT_GENERAL = new Set([...checkoutSettings_1.SECTIONS, '_id', '__v', 'createdAt', 'updatedAt']);
const zodErrors = (err) => err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
exports.getSettings = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const settings = (await Settings_1.Settings.findOne().lean()) ?? (await Settings_1.Settings.create({})).toObject();
    const general = Object.fromEntries(Object.entries(settings).filter(([k]) => !checkoutSettings_1.SECTIONS.includes(k)));
    // The storefront chrome (banner, footer, WhatsApp) must keep working even if checkout settings are broken;
    // checkout itself refuses to price an order in that case (see /payments/calculate-shipping).
    let checkout = null;
    try {
        checkout = (0, checkoutSettings_1.publicCheckoutSettings)((0, checkoutSettings_1.effectiveCheckoutSettings)(settings).settings);
    }
    catch (err) {
        console.error('Checkout settings unavailable:', err?.message);
    }
    (0, responseHandler_1.successResponse)(res, 200, 'Settings fetched successfully', { ...general, checkout });
});
/** General settings: every field optional (only what the form sends is changed); unknown keys are dropped. */
const generalSettingsSchema = zod_1.z.object({
    bannerText: zod_1.z.string().max(2000),
    isBannerActive: zod_1.z.boolean(),
    footerText: zod_1.z.string().max(500),
    // Stored as digits only (the storefront builds wa.me links from it); spaces, + and dashes are tolerated on input
    whatsappNumber: zod_1.z.string().transform((v) => v.replace(/[\s+()-]/g, '')).pipe(zod_1.z.string().regex(/^\d{8,15}$/, 'WhatsApp number: 8-15 digits including the country code, e.g. 919847978098')),
    primaryColor: zod_1.z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be like #8B5E34'),
    secondaryColor: zod_1.z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be like #F5F1E8'),
    shippingBelow500g: zod_1.z.number().finite().min(0),
    shippingAbove500g: zod_1.z.number().finite().min(0),
    shippingWeightThreshold: zod_1.z.number().finite().min(0),
    freeShippingThreshold: zod_1.z.number().finite().min(0),
    giftingTitle: zod_1.z.string().trim().max(120),
    giftingSubtitle: zod_1.z.string().trim().max(300),
    newArrivalsTitle: zod_1.z.string().trim().max(120),
    newArrivalsSubtitle: zod_1.z.string().trim().max(300),
}).partial();
exports.updateSettings = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const body = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => !NOT_GENERAL.has(k)));
    const parsed = generalSettingsSchema.safeParse(body);
    if (!parsed.success)
        return (0, responseHandler_1.errorResponse)(res, 400, 'Please correct the highlighted fields', zodErrors(parsed.error));
    // Single settings document: update it in place (created once if missing), never insert another
    const settings = await Settings_1.Settings.findOneAndUpdate({}, { $set: parsed.data }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true });
    (0, responseHandler_1.successResponse)(res, 200, 'Settings updated successfully', settings);
});
const checkoutResponse = (doc) => {
    const { settings, saved } = (0, checkoutSettings_1.effectiveCheckoutSettings)(doc);
    return { settings, saved, updatedAt: doc?.updatedAt ?? null };
};
/** Admin: full checkout & fulfilment settings, with which sections are still on derived defaults. */
exports.getCheckoutSettings = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    try {
        (0, responseHandler_1.successResponse)(res, 200, 'Checkout settings fetched', checkoutResponse(await Settings_1.Settings.findOne().lean()));
    }
    catch (err) {
        if (err instanceof checkoutSettings_1.CheckoutSettingsError)
            return (0, responseHandler_1.errorResponse)(res, 500, err.message);
        throw err;
    }
});
/** Admin: replace one section (shipping | pickup | chocolate | tax) after full validation. */
exports.updateCheckoutSection = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const section = req.params.section;
    if (!checkoutSettings_1.SECTIONS.includes(section))
        return (0, responseHandler_1.errorResponse)(res, 404, `Unknown settings section "${req.params.section}"`);
    if (section === 'tax' && req.user?.role !== 'superadmin')
        return (0, responseHandler_1.errorResponse)(res, 403, 'Only a super admin can change tax settings');
    const parsed = checkoutSettings_1.SECTION_SCHEMAS[section].safeParse(req.body);
    if (!parsed.success)
        return (0, responseHandler_1.errorResponse)(res, 400, 'Please correct the highlighted fields', zodErrors(parsed.error));
    const value = parsed.data;
    const current = await (0, checkoutSettings_1.loadCheckoutSettings)();
    const next = { ...current.settings, [section]: value };
    if (!(0, checkoutSettings_1.fulfilmentAvailable)(next)) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'At least one way to receive orders must stay available (a delivery method or store pickup)', [{ field: section, message: 'Would leave no delivery or pickup option' }]);
    }
    if (section === 'tax' && next.tax.enabled && !next.tax.pricesIncludeTax) {
        const missing = await Product_1.Product.countDocuments({ $or: [{ taxRate: null }, { taxRate: { $exists: false } }] });
        if (missing) {
            return (0, responseHandler_1.errorResponse)(res, 400, `Tax-exclusive pricing needs a GST rate on every product: ${missing} product(s) have none`, [{ field: 'pricesIncludeTax', message: `${missing} product(s) without a GST rate` }]);
        }
    }
    const doc = await Settings_1.Settings.findOneAndUpdate({}, { $set: { [section]: value } }, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
    (0, responseHandler_1.successResponse)(res, 200, 'Settings saved', checkoutResponse(doc));
});
/** Admin: products with their special-packaging flag and GST rate. */
exports.listCheckoutProducts = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const products = await Product_1.Product.find({}, { name: 1, category: 1, images: { $slice: 1 }, weight: 1, 'variants.weight': 1, 'variants.volume': 1, requiresSpecialPackaging: 1, taxRate: 1, hsnCode: 1 })
        .sort({ name: 1 }).lean();
    (0, responseHandler_1.successResponse)(res, 200, 'Products fetched', products.map((p) => ({
        _id: String(p._id), name: p.name, category: p.category, image: p.images?.[0] ?? null,
        requiresSpecialPackaging: p.requiresSpecialPackaging === true, taxRate: typeof p.taxRate === 'number' ? p.taxRate : null, hsnCode: p.hsnCode ?? '',
    })));
});
const productUpdatesSchema = zod_1.z.object({
    updates: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string().refine((v) => mongoose_1.default.isValidObjectId(v), 'Invalid product id'),
        requiresSpecialPackaging: zod_1.z.boolean().optional(),
        taxRate: zod_1.z.number().finite().min(0).max(100).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'At most 2 decimal places').nullable().optional(),
        hsnCode: zod_1.z.string().trim().regex(/^[0-9]{0,8}$/, 'HSN code is up to 8 digits').optional(),
    }).strict()).min(1).max(1000),
}).strict();
/** Admin: set special packaging (admin) and GST rate / HSN (super admin) on products. Only the given fields change. */
exports.updateCheckoutProducts = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const parsed = productUpdatesSchema.safeParse(req.body);
    if (!parsed.success)
        return (0, responseHandler_1.errorResponse)(res, 400, 'Please correct the highlighted fields', zodErrors(parsed.error));
    const { updates } = parsed.data;
    const touchesTax = updates.some((u) => u.taxRate !== undefined || u.hsnCode !== undefined);
    if (touchesTax && req.user?.role !== 'superadmin')
        return (0, responseHandler_1.errorResponse)(res, 403, 'Only a super admin can change GST rates');
    // Tax-exclusive pricing cannot have a product without a rate (its total would be wrong)
    const { settings } = await (0, checkoutSettings_1.loadCheckoutSettings)();
    if (settings.tax.enabled && !settings.tax.pricesIncludeTax && updates.some((u) => u.taxRate === null)) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Prices are tax-exclusive: every product needs a GST rate', [{ field: 'taxRate', message: 'Cannot clear a GST rate while prices are tax-exclusive' }]);
    }
    const result = await Product_1.Product.bulkWrite(updates.map((u) => {
        const set = {};
        if (u.requiresSpecialPackaging !== undefined)
            set.requiresSpecialPackaging = u.requiresSpecialPackaging;
        if (u.taxRate !== undefined)
            set.taxRate = u.taxRate;
        if (u.hsnCode !== undefined)
            set.hsnCode = u.hsnCode;
        return { updateOne: { filter: { _id: new mongoose_1.default.Types.ObjectId(u.id) }, update: { $set: set } } };
    }));
    if (result.matchedCount !== updates.length) {
        return (0, responseHandler_1.errorResponse)(res, 404, `${updates.length - result.matchedCount} product(s) were not found; the others were saved`);
    }
    (0, responseHandler_1.successResponse)(res, 200, 'Products updated', { matched: result.matchedCount, modified: result.modifiedCount });
});
//# sourceMappingURL=settingsController.js.map