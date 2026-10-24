import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Settings } from '../models/Settings';
import { Product } from '../models/Product';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import {
  SECTIONS, SECTION_SCHEMAS, Section, CheckoutSettingsError, effectiveCheckoutSettings, fulfilmentAvailable, loadCheckoutSettings, publicCheckoutSettings,
} from '../utils/checkoutSettings';

// Checkout sections are only written through their validated endpoints below, never through the general settings PUT
const NOT_GENERAL = new Set<string>([...SECTIONS, '_id', '__v', 'createdAt', 'updatedAt']);

const zodErrors = (err: z.ZodError) => err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));

export const getSettings = asyncHandler(async (req: Request, res: Response) => {
  const settings: any = (await Settings.findOne().lean()) ?? (await Settings.create({})).toObject();
  const general = Object.fromEntries(Object.entries(settings).filter(([k]) => !SECTIONS.includes(k as Section)));
  // The storefront chrome (banner, footer, WhatsApp) must keep working even if checkout settings are broken;
  // checkout itself refuses to price an order in that case (see /payments/calculate-shipping).
  let checkout = null;
  try {
    checkout = publicCheckoutSettings(effectiveCheckoutSettings(settings).settings);
  } catch (err: any) {
    console.error('Checkout settings unavailable:', err?.message);
  }
  successResponse(res, 200, 'Settings fetched successfully', { ...general, checkout });
});

/** General settings: every field optional (only what the form sends is changed); unknown keys are dropped. */
const generalSettingsSchema = z.object({
  bannerText: z.string().max(2000),
  isBannerActive: z.boolean(),
  footerText: z.string().max(500),
  // Stored as digits only (the storefront builds wa.me links from it); spaces, + and dashes are tolerated on input
  whatsappNumber: z.string().transform((v) => v.replace(/[\s+()-]/g, '')).pipe(z.string().regex(/^\d{8,15}$/, 'WhatsApp number: 8-15 digits including the country code, e.g. 919847978098')),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be like #8B5E34'),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be like #F5F1E8'),
  shippingBelow500g: z.number().finite().min(0),
  shippingAbove500g: z.number().finite().min(0),
  shippingWeightThreshold: z.number().finite().min(0),
  freeShippingThreshold: z.number().finite().min(0),
  giftingTitle: z.string().trim().max(120),
  giftingSubtitle: z.string().trim().max(300),
  newArrivalsTitle: z.string().trim().max(120),
  newArrivalsSubtitle: z.string().trim().max(300),
}).partial();

export const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  const body = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => !NOT_GENERAL.has(k)));
  const parsed = generalSettingsSchema.safeParse(body);
  if (!parsed.success) return errorResponse(res, 400, 'Please correct the highlighted fields', zodErrors(parsed.error));
  // Single settings document: update it in place (created once if missing), never insert another
  const settings = await Settings.findOneAndUpdate({}, { $set: parsed.data }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true });
  successResponse(res, 200, 'Settings updated successfully', settings);
});

const checkoutResponse = (doc: any) => {
  const { settings, saved } = effectiveCheckoutSettings(doc);
  return { settings, saved, updatedAt: doc?.updatedAt ?? null };
};

/** Admin: full checkout & fulfilment settings, with which sections are still on derived defaults. */
export const getCheckoutSettings = asyncHandler(async (req: Request, res: Response) => {
  try {
    successResponse(res, 200, 'Checkout settings fetched', checkoutResponse(await Settings.findOne().lean()));
  } catch (err) {
    if (err instanceof CheckoutSettingsError) return errorResponse(res, 500, err.message);
    throw err;
  }
});

/** Admin: replace one section (shipping | pickup | chocolate | tax) after full validation. */
export const updateCheckoutSection = asyncHandler(async (req: Request, res: Response) => {
  const section = req.params.section as Section;
  if (!SECTIONS.includes(section)) return errorResponse(res, 404, `Unknown settings section "${req.params.section}"`);
  if (section === 'tax' && req.user?.role !== 'superadmin') return errorResponse(res, 403, 'Only a super admin can change tax settings');

  const parsed = SECTION_SCHEMAS[section].safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, 'Please correct the highlighted fields', zodErrors(parsed.error));
  const value = parsed.data;

  const current = await loadCheckoutSettings();
  const next = { ...current.settings, [section]: value };
  if (!fulfilmentAvailable(next)) {
    return errorResponse(res, 400, 'At least one way to receive orders must stay available (a delivery method or store pickup)', [{ field: section, message: 'Would leave no delivery or pickup option' }]);
  }
  if (section === 'tax' && next.tax.enabled && !next.tax.pricesIncludeTax) {
    const missing = await Product.countDocuments({ $or: [{ taxRate: null }, { taxRate: { $exists: false } }] });
    if (missing) {
      return errorResponse(res, 400, `Tax-exclusive pricing needs a GST rate on every product: ${missing} product(s) have none`, [{ field: 'pricesIncludeTax', message: `${missing} product(s) without a GST rate` }]);
    }
  }

  const doc = await Settings.findOneAndUpdate({}, { $set: { [section]: value } }, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
  successResponse(res, 200, 'Settings saved', checkoutResponse(doc));
});

/** Admin: products with their special-packaging flag and GST rate. */
export const listCheckoutProducts = asyncHandler(async (req: Request, res: Response) => {
  const products = await Product.find({}, { name: 1, category: 1, images: { $slice: 1 }, weight: 1, 'variants.weight': 1, 'variants.volume': 1, requiresSpecialPackaging: 1, taxRate: 1, hsnCode: 1 })
    .sort({ name: 1 }).lean();
  successResponse(res, 200, 'Products fetched', products.map((p: any) => ({
    _id: String(p._id), name: p.name, category: p.category, image: p.images?.[0] ?? null,
    requiresSpecialPackaging: p.requiresSpecialPackaging === true, taxRate: typeof p.taxRate === 'number' ? p.taxRate : null, hsnCode: p.hsnCode ?? '',
  })));
});

const productUpdatesSchema = z.object({
  updates: z.array(z.object({
    id: z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid product id'),
    requiresSpecialPackaging: z.boolean().optional(),
    taxRate: z.number().finite().min(0).max(100).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'At most 2 decimal places').nullable().optional(),
    hsnCode: z.string().trim().regex(/^[0-9]{0,8}$/, 'HSN code is up to 8 digits').optional(),
  }).strict()).min(1).max(1000),
}).strict();

/** Admin: set special packaging (admin) and GST rate / HSN (super admin) on products. Only the given fields change. */
export const updateCheckoutProducts = asyncHandler(async (req: Request, res: Response) => {
  const parsed = productUpdatesSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, 'Please correct the highlighted fields', zodErrors(parsed.error));
  const { updates } = parsed.data;
  const touchesTax = updates.some((u) => u.taxRate !== undefined || u.hsnCode !== undefined);
  if (touchesTax && req.user?.role !== 'superadmin') return errorResponse(res, 403, 'Only a super admin can change GST rates');

  // Tax-exclusive pricing cannot have a product without a rate (its total would be wrong)
  const { settings } = await loadCheckoutSettings();
  if (settings.tax.enabled && !settings.tax.pricesIncludeTax && updates.some((u) => u.taxRate === null)) {
    return errorResponse(res, 400, 'Prices are tax-exclusive: every product needs a GST rate', [{ field: 'taxRate', message: 'Cannot clear a GST rate while prices are tax-exclusive' }]);
  }

  const result = await Product.bulkWrite(updates.map((u) => {
    const set: Record<string, unknown> = {};
    if (u.requiresSpecialPackaging !== undefined) set.requiresSpecialPackaging = u.requiresSpecialPackaging;
    if (u.taxRate !== undefined) set.taxRate = u.taxRate;
    if (u.hsnCode !== undefined) set.hsnCode = u.hsnCode;
    return { updateOne: { filter: { _id: new mongoose.Types.ObjectId(u.id) }, update: { $set: set } } };
  }));
  if (result.matchedCount !== updates.length) {
    return errorResponse(res, 404, `${updates.length - result.matchedCount} product(s) were not found; the others were saved`);
  }
  successResponse(res, 200, 'Products updated', { matched: result.matchedCount, modified: result.modifiedCount });
});
