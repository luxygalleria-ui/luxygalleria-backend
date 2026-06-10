"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upload = void 0;
const multer_1 = __importDefault(require("multer"));
const cloudinary_1 = require("cloudinary");
const multer_storage_cloudinary_1 = require("multer-storage-cloudinary");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
// Configure Cloudinary
cloudinary_1.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});
// Check if Cloudinary is properly configured
const isCloudinaryConfigured = process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET &&
    process.env.CLOUDINARY_CLOUD_NAME !== 'dummy_cloud' &&
    process.env.CLOUDINARY_API_KEY !== 'dummy_api_key';
let storage;
if (isCloudinaryConfigured) {
    // Use Cloudinary storage when properly configured
    storage = new multer_storage_cloudinary_1.CloudinaryStorage({
        cloudinary: cloudinary_1.v2,
        params: async (req, file) => {
            return {
                folder: 'luxygalleria_products', // Changed from heedy to luxy
                allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
                public_id: file.fieldname + '-' + Date.now(),
            };
        },
    });
}
else {
    // Use local storage when Cloudinary is not configured
    const uploadsDir = path_1.default.join(process.cwd(), 'uploads');
    if (!fs_1.default.existsSync(uploadsDir)) {
        fs_1.default.mkdirSync(uploadsDir, { recursive: true });
    }
    storage = multer_1.default.diskStorage({
        destination: (req, file, cb) => {
            cb(null, uploadsDir);
        },
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, file.fieldname + '-' + uniqueSuffix + path_1.default.extname(file.originalname));
        },
    });
}
exports.upload = (0, multer_1.default)({
    storage: storage,
    limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});
//# sourceMappingURL=uploadMiddleware.js.map