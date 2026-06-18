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
exports.VideoTestimonial = exports.extractYoutubeId = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const extractYoutubeId = (url) => {
    if (!url)
        return null;
    // Regex to match various YouTube URL formats (standard, short, share, live, embed)
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|shorts\/|live\/)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
};
exports.extractYoutubeId = extractYoutubeId;
const videoTestimonialSchema = new mongoose_1.Schema({
    clientName: { type: String, required: true, trim: true },
    role: { type: String, required: true, trim: true },
    youtubeUrl: { type: String, required: true, trim: true },
    youtubeId: { type: String, required: true },
    thumbnailUrl: { type: String, required: true },
    displayOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
}, { timestamps: true });
videoTestimonialSchema.pre('validate', function (next) {
    if (this.isModified('youtubeUrl')) {
        const id = (0, exports.extractYoutubeId)(this.youtubeUrl);
        if (!id) {
            return next(new Error('Invalid YouTube URL provided. Please provide a valid YouTube video URL.'));
        }
        this.youtubeId = id;
        this.thumbnailUrl = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
    }
    next();
});
exports.VideoTestimonial = mongoose_1.default.model('VideoTestimonial', videoTestimonialSchema);
//# sourceMappingURL=VideoTestimonial.js.map