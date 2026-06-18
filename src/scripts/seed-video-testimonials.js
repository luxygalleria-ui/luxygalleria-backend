const mongoose = require('mongoose');

const MONGO_URI = 'mongodb+srv://luxygalleria_db_user:edDnNHp379axfIo1@cluster0.vtzh76l.mongodb.net/luxy';

const videoTestimonialSchema = new mongoose.Schema(
  {
    clientName: { type: String, required: true },
    role: { type: String, required: true },
    youtubeUrl: { type: String, required: true },
    youtubeId: { type: String, required: true },
    thumbnailUrl: { type: String, required: true },
    displayOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

const VideoTestimonial = mongoose.models.VideoTestimonial || mongoose.model('VideoTestimonial', videoTestimonialSchema);

const extractYoutubeId = (url) => {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|shorts\/|live\/)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
};

const samples = [
  {
    clientName: 'Sophia Loren',
    role: 'Fine Wine Connoisseur',
    youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    displayOrder: 1,
    isActive: true
  },
  {
    clientName: 'Marcus Aurelius',
    role: 'Premium Snack Lover',
    youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    displayOrder: 2,
    isActive: true
  },
  {
    clientName: 'Elena Rostova',
    role: 'VIP Beverages Collector',
    youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    displayOrder: 3,
    isActive: true
  }
];

async function seed() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(MONGO_URI);
    console.log('Connected!');

    // Clear existing video testimonials
    await VideoTestimonial.deleteMany({});
    console.log('Cleared existing video testimonials.');

    for (const s of samples) {
      const id = extractYoutubeId(s.youtubeUrl);
      const testimonial = new VideoTestimonial({
        ...s,
        youtubeId: id,
        thumbnailUrl: `https://img.youtube.com/vi/${id}/hqdefault.jpg`
      });
      await testimonial.save();
      console.log(`Seeded testimonial for ${s.clientName}`);
    }

    console.log('Database seeding completed successfully!');
  } catch (error) {
    console.error('Seeding failed:', error);
  } finally {
    await mongoose.disconnect();
  }
}

seed();
