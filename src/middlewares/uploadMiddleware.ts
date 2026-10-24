import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import path from 'path';
import fs from 'fs';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Check if Cloudinary is properly configured
const isCloudinaryConfigured = 
  process.env.CLOUDINARY_CLOUD_NAME && 
  process.env.CLOUDINARY_API_KEY && 
  process.env.CLOUDINARY_API_SECRET &&
  process.env.CLOUDINARY_CLOUD_NAME !== 'dummy_cloud' &&
  process.env.CLOUDINARY_API_KEY !== 'dummy_api_key';

// Startup line so the effective cloud (read once at boot; a later .env edit needs a restart) shows in the process logs. Cloud name is public.
console.log(isCloudinaryConfigured
  ? `🖼️  Image uploads: Cloudinary cloud "${process.env.CLOUDINARY_CLOUD_NAME}"`
  : '⚠️  Image uploads: Cloudinary NOT configured (CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET) — saving to local disk');

let storage: multer.StorageEngine;

if (isCloudinaryConfigured) {
  // Use Cloudinary storage when properly configured
  storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
      return {
        folder: 'luxygalleria_products', // Changed from heedy to luxy
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
        public_id: file.fieldname + '-' + Date.now(),
      };
    },
  });
} else {
  // Use local storage when Cloudinary is not configured
  const uploadsDir = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const disk = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    },
  });
  // Controllers save file.path as the image URL: report the public /uploads/<name> path, not the server's filesystem path
  storage = {
    _handleFile: (req, file, cb) => disk._handleFile(req, file, (err, info) => cb(err, info && { ...info, path: `/uploads/${info.filename}` })),
    _removeFile: (req, file, cb) => disk._removeFile(req, { ...file, path: path.join(uploadsDir, file.filename) }, cb),
  };
}

const ALLOWED_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

export const upload = multer({ 
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
  // Images only: local disk storage keeps the client's extension, and /uploads is served statically
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') && ALLOWED_IMAGE_EXT.includes(path.extname(file.originalname).toLowerCase());
    if (ok) return cb(null, true);
    cb(Object.assign(new Error('Only JPG, PNG or WEBP images are allowed'), { statusCode: 400 }));
  },
});
