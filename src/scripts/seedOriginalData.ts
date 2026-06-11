import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Product } from '../models/Product';
import { Category } from '../models/Category';

dotenv.config();

const seedData = async () => {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/luxy-db';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Clear existing data
    console.log('\n🗑️  Clearing old demo data...');
    await Product.deleteMany({});
    await Category.deleteMany({});
    console.log('✅ Cleared old products and categories');

    // Create categories
    console.log('\n📂 Creating categories...');
    const categories = await Category.insertMany([
      {
        name: 'Drinks',
        image: '/images/drinks-category.jpg',
        status: 'ACTIVE',
      },
      {
        name: 'Sweet',
        image: '/images/sweet-category.jpg',
        status: 'ACTIVE',
      },
    ]);
    console.log('✅ Created categories:', categories.map(c => c.name).join(', '));

    // Create products
    console.log('\n📦 Creating products...');
    const products = await Product.insertMany([
      {
        name: 'Orange Juice',
        category: 'Drinks',
        description: 'Fresh squeezed orange juice, rich in vitamin C and natural flavors',
        variants: [
          { volume: '250ml', price: 45, oldPrice: 50 },
          { volume: '500ml', price: 80, oldPrice: 95 },
          { volume: '1L', price: 150, oldPrice: 180 },
        ],
        starRating: 4.5,
        reviewsCount: 128,
        offerText: 'Fresh & Natural',
        keyFeatures: 'No added sugar, 100% natural',
        images: ['/images/products/orange-juice.jpg'],
        status: 'In Stock',
        showOnLandingPage: true,
        stock: 50,
        weight: 0.25,
      },
      {
        name: 'Mango Shake',
        category: 'Drinks',
        description: 'Creamy mango milkshake made with fresh mango pulp and milk',
        variants: [
          { volume: '200ml', price: 60, oldPrice: 70 },
          { volume: '400ml', price: 110, oldPrice: 130 },
        ],
        starRating: 4.8,
        reviewsCount: 245,
        offerText: 'Summer Special',
        keyFeatures: 'Fresh mango, full cream milk',
        images: ['/images/products/mango-shake.jpg'],
        status: 'In Stock',
        showOnLandingPage: true,
        stock: 40,
        weight: 0.2,
      },
      {
        name: 'Chocolate Brownies',
        category: 'Sweet',
        description: 'Decadent chocolate brownies, fudgy and rich, perfect dessert treat',
        variants: [
          { volume: '100g (4 pcs)', price: 120, oldPrice: 150 },
          { volume: '250g (10 pcs)', price: 280, oldPrice: 350 },
          { volume: '500g (20 pcs)', price: 500, oldPrice: 650 },
        ],
        starRating: 4.7,
        reviewsCount: 156,
        offerText: 'Homemade Quality',
        keyFeatures: 'No preservatives, fresh daily',
        images: ['/images/products/chocolate-brownies.jpg'],
        status: 'In Stock',
        showOnLandingPage: true,
        stock: 35,
        weight: 0.1,
      },
      {
        name: 'Strawberry Cheesecake',
        category: 'Sweet',
        description: 'Creamy cheesecake topped with fresh strawberries and chocolate sauce',
        variants: [
          { volume: '200g', price: 200, oldPrice: 250 },
          { volume: '500g', price: 450, oldPrice: 550 },
          { volume: '1kg', price: 800, oldPrice: 1000 },
        ],
        starRating: 4.9,
        reviewsCount: 189,
        offerText: 'Premium Dessert',
        keyFeatures: 'Handcrafted, premium ingredients',
        images: ['/images/products/strawberry-cheesecake.jpg'],
        status: 'In Stock',
        showOnLandingPage: true,
        stock: 25,
        weight: 0.2,
      },
      {
        name: 'Vanilla Ice Cream',
        category: 'Drinks',
        description: 'Smooth and creamy vanilla ice cream made with real vanilla beans',
        variants: [
          { volume: '250ml', price: 70, oldPrice: 85 },
          { volume: '500ml', price: 130, oldPrice: 160 },
          { volume: '1L', price: 240, oldPrice: 300 },
        ],
        starRating: 4.6,
        reviewsCount: 312,
        offerText: 'Cool Treats',
        keyFeatures: 'No artificial flavors',
        images: ['/images/products/vanilla-ice-cream.jpg'],
        status: 'In Stock',
        showOnLandingPage: true,
        stock: 60,
        weight: 0.25,
      },
      {
        name: 'Gulab Jamun',
        category: 'Sweet',
        description: 'Traditional Indian sweets - soft gulab jamun in sugar syrup',
        variants: [
          { volume: '200g (8 pcs)', price: 90, oldPrice: 110 },
          { volume: '500g (20 pcs)', price: 200, oldPrice: 250 },
        ],
        starRating: 4.4,
        reviewsCount: 98,
        offerText: 'Traditional Indian',
        keyFeatures: 'Authentic recipe',
        images: ['/images/products/gulab-jamun.jpg'],
        status: 'In Stock',
        showOnLandingPage: true,
        stock: 30,
        weight: 0.2,
      },
    ]);
    console.log('✅ Created products:', products.length);

    // Summary
    console.log('\n📊 Data Seeding Summary:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Categories: ${categories.length}`);
    console.log(`Products: ${products.length}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n📋 Categories Created:');
    categories.forEach(cat => console.log(`  • ${cat.name}`));
    console.log('\n📦 Products Created:');
    products.forEach(prod => console.log(`  • ${prod.name} (${prod.category})`));

    await mongoose.disconnect();
    console.log('\n✅ Database seeding completed successfully!');
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    process.exit(1);
  }
};

seedData();
