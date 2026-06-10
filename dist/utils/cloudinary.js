"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadOnCloudinary = void 0;
const cloudinary_1 = __importDefault(require("cloudinary"));
const fs_1 = __importDefault(require("fs"));
// Configure Cloudinary using environment variables
cloudinary_1.default.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});
/**
 * Upload a local file to Cloudinary.
 * The function uploads the file, deletes the temporary local file,
 * and returns the Cloudinary response (containing url, public_id, etc.).
 *
 * @param localFilePath Absolute path to the temporary file (e.g., from multer).
 * @returns Cloudinary upload response or null on error.
 */
const uploadOnCloudinary = async (localFilePath) => {
    try {
        if (!localFilePath)
            return null;
        const result = await cloudinary_1.default.v2.uploader.upload(localFilePath, {
            resource_type: 'auto', // Handles images, videos, etc.
        });
        // Clean up the local temp file
        fs_1.default.unlinkSync(localFilePath);
        return result;
    }
    catch (error) {
        // Ensure we delete the temp file even if upload fails
        try {
            fs_1.default.unlinkSync(localFilePath);
        }
        catch (_) { }
        console.error('Cloudinary upload error:', error);
        return null;
    }
};
exports.uploadOnCloudinary = uploadOnCloudinary;
//# sourceMappingURL=cloudinary.js.map