import mongoose, { Document, Schema } from 'mongoose';

export interface IVideoTestimonial extends Document {
  clientName: string;
  role: string;
  youtubeUrl: string;
  youtubeId: string;
  thumbnailUrl: string;
  displayOrder: number;
  isActive: boolean;
}

export const extractYoutubeId = (url: string): string | null => {
  if (!url) return null;
  // Regex to match various YouTube URL formats (standard, short, share, live, embed)
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|shorts\/|live\/)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
};

const videoTestimonialSchema = new Schema<IVideoTestimonial>(
  {
    clientName: { type: String, required: true, trim: true },
    role: { type: String, required: true, trim: true },
    youtubeUrl: { type: String, required: true, trim: true },
    youtubeId: { type: String, required: true },
    thumbnailUrl: { type: String, required: true },
    displayOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

videoTestimonialSchema.pre('validate', function (next) {
  if (this.isModified('youtubeUrl')) {
    const id = extractYoutubeId(this.youtubeUrl);
    if (!id) {
      return next(new Error('Invalid YouTube URL provided. Please provide a valid YouTube video URL.'));
    }
    this.youtubeId = id;
    this.thumbnailUrl = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
  }
  next();
});

export const VideoTestimonial = mongoose.model<IVideoTestimonial>('VideoTestimonial', videoTestimonialSchema);
