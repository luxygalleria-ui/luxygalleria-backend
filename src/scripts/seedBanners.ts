import mongoose from 'mongoose';
import { Banner } from '../models/Banner';
import dotenv from 'dotenv';

dotenv.config();

const seedBanners = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/luxy-galleria'; // same order as config/env.ts
    // Demo seed that wipes collections: never run it against a shared or production database
    if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)[:/]/.test(mongoUri)) throw new Error('Seed scripts only run against a local MongoDB (localhost/127.0.0.1)');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Clear old banners
    await Banner.deleteMany({});
    console.log('🗑️  Cleared old banners');

    // Create sample banners for Drinks & Sweets
    const banners = [
      {
        title: 'Refreshing Drinks Collection',
        description: 'Enjoy our premium selection of fresh and delicious drinks',
        image: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=1200&h=400&fit=crop',
        mobileImage: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=600&h=400&fit=crop',
        status: 'ACTIVE',
      },
      {
        title: 'Sweet Treats Galore',
        description: 'Indulge in our delectable selection of sweets and desserts',
        image: 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=1200&h=400&fit=crop',
        mobileImage: 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=600&h=400&fit=crop',
        status: 'ACTIVE',
      },
      {
        title: 'Special Combo Offers',
        description: 'Get the best deals on your favorite drinks and sweets',
        image: 'https://images.unsplash.com/photo-1621939514649-280e2ee25f60?w=1200&h=400&fit=crop',
        mobileImage: 'https://images.unsplash.com/photo-1621939514649-280e2ee25f60?w=600&h=400&fit=crop',
        status: 'ACTIVE',
      },
    ];

    const createdBanners = await Banner.insertMany(banners);
    console.log(`📂 Created ${createdBanners.length} banners`);
    
    console.log('\n✅ Banner seeding completed successfully!');
    console.log('Banners created:');
    createdBanners.forEach((banner) => {
      console.log(`  - ${banner.title}`);
    });

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding banners:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
};

seedBanners();
