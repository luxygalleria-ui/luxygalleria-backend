import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Product } from '../models/Product';

dotenv.config();

const run = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/luxy-db';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const products = await Product.find({});
    console.log('--- PRODUCTS IN DATABASE ---');
    products.forEach(p => {
      console.log(`Product ID: ${p._id}`);
      console.log(`Name: ${p.name}`);
      console.log(`Product Weight (kg): ${p.weight}`);
      console.log(`Variants:`);
      p.variants.forEach(v => {
        console.log(`  - Volume: ${v.volume}, Price: ${v.price}, Weight (v): ${v.weight}`);
      });
      console.log('----------------------------');
    });

    await mongoose.disconnect();
  } catch (err) {
    console.error(err);
  }
};

run();
