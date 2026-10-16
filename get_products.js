require('dotenv').config();
const mongoose = require('mongoose');

const mongoUri = process.env.MONGO_URI;

async function run() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(mongoUri);
    console.log("Connected successfully!");

    const Product = mongoose.model('Product', new mongoose.Schema({
      name: String,
      variants: [{
        volume: String,
        price: Number,
        offerPrice: Number,
        actualPrice: Number,
        weight: Number,
        stock: Number
      }],
      weight: Number
    }));

    const products = await Product.find({ name: /dark/i });
    console.log(`Found ${products.length} products matching 'dark':`);
    console.log(JSON.stringify(products, null, 2));

  } catch (err) {
    console.error("Error:", err);
  } finally {
    await mongoose.disconnect();
  }
}

run();
