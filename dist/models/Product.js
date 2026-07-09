"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Product = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const variantSchema = new mongoose_1.Schema({
    volume: { type: String, required: true },
    size: { type: String },
    flavor: { type: String, default: 'Default' },
    price: { type: Number, required: true }, // backward compatibility
    oldPrice: { type: Number }, // backward compatibility
    offerPrice: { type: Number, required: true },
    actualPrice: { type: Number, required: true },
    stock: { type: Number, required: true, default: 0 },
    weight: { type: Number, required: true, default: 0 },
    image: { type: String },
    sku: { type: String },
    description: { type: String },
    name: { type: String },
});
const productSchema = new mongoose_1.Schema({
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true },
    description: { type: String, required: true },
    variants: [variantSchema],
    starRating: { type: Number, default: 0, min: 0, max: 5 },
    reviewsCount: { type: Number, default: 0 },
    offerText: { type: String },
    keyFeatures: { type: String },
    images: [{ type: String }],
    status: { type: String, default: 'In Stock' },
    showOnLandingPage: { type: Boolean, default: false },
    stock: { type: Number, default: 0 },
    weight: { type: Number, default: 0 },
}, { timestamps: true });
exports.Product = mongoose_1.default.model('Product', productSchema);
//# sourceMappingURL=Product.js.map