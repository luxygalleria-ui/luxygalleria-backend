"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const dotenv_1 = __importDefault(require("dotenv"));
const Product_1 = require("../models/Product");
dotenv_1.default.config();
const run = async () => {
    try {
        const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/luxy-db';
        await mongoose_1.default.connect(mongoUri);
        console.log('Connected to MongoDB');
        const products = await Product_1.Product.find({});
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
        await mongoose_1.default.disconnect();
    }
    catch (err) {
        console.error(err);
    }
};
run();
//# sourceMappingURL=dumpProducts.js.map