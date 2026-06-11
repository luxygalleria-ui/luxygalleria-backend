import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Category } from '../models/Category';

dotenv.config();

const updateCategories = async () => {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/luxy-db';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Update categories
    const updates = [
      { old: 'darkcholate', new: 'Drinks' },
      { old: 'prime', new: 'Sweet' }
    ];

    for (const update of updates) {
      const result = await Category.updateMany(
        { name: new RegExp('^' + update.old + '$', 'i') },
        { name: update.new }
      );
      
      if (result.modifiedCount > 0) {
        console.log(`✅ Updated ${result.modifiedCount} category from "${update.old}" to "${update.new}"`);
      } else {
        console.log(`ℹ️  No categories found with name "${update.old}"`);
      }
    }

    // Verify the updates
    const allCategories = await Category.find().select('name');
    console.log('\n📋 All categories after update:');
    allCategories.forEach(cat => console.log(`  - ${cat.name}`));

    await mongoose.disconnect();
    console.log('\n✅ Script completed successfully');
  } catch (error) {
    console.error('❌ Error updating categories:', error);
    process.exit(1);
  }
};

updateCategories();
