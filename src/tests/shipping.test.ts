import { calculateShippingPure, parseWeightFromVolume } from '../utils/shippingCalculator';

interface TestCase {
  description: string;
  items: Array<{ price: number; weight: number; quantity: number }>;
  expectedShipping: number;
  expectedGrandTotal: number;
}

const testCases: TestCase[] = [
  {
    description: 'Scenario 1: ₹450 subtotal, 400g weight (Weight <= 500g -> Base shipping ₹40, no extra weight)',
    items: [{ price: 450, weight: 0.4, quantity: 1 }],
    expectedShipping: 40,
    expectedGrandTotal: 490,
  },
  {
    description: 'Scenario 2: ₹450 subtotal, 500g weight (Weight <= 500g -> Base shipping ₹40, no extra weight)',
    items: [{ price: 450, weight: 0.5, quantity: 1 }],
    expectedShipping: 40,
    expectedGrandTotal: 490,
  },
  {
    description: 'Scenario 2b: ₹450 subtotal, 510g weight (Weight > 500g -> Base shipping ₹80, no extra weight)',
    items: [{ price: 450, weight: 0.51, quantity: 1 }],
    expectedShipping: 80,
    expectedGrandTotal: 530,
  },
  {
    description: 'Scenario 3: ₹800 subtotal, 1kg weight (Weight > 500g -> Base shipping ₹80, no extra weight)',
    items: [{ price: 800, weight: 1.0, quantity: 1 }],
    expectedShipping: 80,
    expectedGrandTotal: 880,
  },
  {
    description: 'Scenario 4: ₹800 subtotal, 2kg weight (Weight >= 500g -> Base shipping ₹80, +1kg extra weight ₹20)',
    items: [{ price: 800, weight: 2.0, quantity: 1 }],
    expectedShipping: 100,
    expectedGrandTotal: 900,
  },
  {
    description: 'Scenario 5: ₹800 subtotal, 3kg weight (Weight >= 500g -> Base shipping ₹80, +2kg extra weight ₹40)',
    items: [{ price: 800, weight: 3.0, quantity: 1 }],
    expectedShipping: 120,
    expectedGrandTotal: 920,
  },
  {
    description: 'Scenario 6: ₹1200 subtotal, 5kg weight (Weight >= 500g -> Base shipping ₹80, +4kg extra weight ₹80)',
    items: [{ price: 1200, weight: 5.0, quantity: 1 }],
    expectedShipping: 160,
    expectedGrandTotal: 1360,
  },
  {
    description: 'Extra Check: ₹1200 subtotal, 1.4kg weight (Weight >= 500g -> Base shipping ₹80, +0.4kg extra weight rounded up to 1kg = ₹20)',
    items: [{ price: 1200, weight: 1.4, quantity: 1 }],
    expectedShipping: 100,
    expectedGrandTotal: 1300,
  },
  {
    description: 'Extra Check: ₹1200 subtotal, 2.3kg weight (Weight >= 500g -> Base shipping ₹80, +1.3kg extra weight rounded up to 2kg = ₹40)',
    items: [{ price: 1200, weight: 2.3, quantity: 1 }],
    expectedShipping: 120,
    expectedGrandTotal: 1320,
  }
];

const runVolumeParserTests = (): boolean => {
  console.log('=== Running Volume Parser Unit Tests ===');
  const cases = [
    { input: '500G', expected: 0.5 },
    { input: '500g', expected: 0.5 },
    { input: '1kg', expected: 1.0 },
    { input: '1Kg', expected: 1.0 },
    { input: '2.5kg', expected: 2.5 },
    { input: '250ml', expected: 0.25 },
    { input: '1L', expected: 1.0 },
    { input: '200g (8 pcs)', expected: 0.2 },
    { input: '250g (10 pcs)', expected: 0.25 },
    { input: '100g (4 pcs)', expected: 0.1 },
    { input: 'invalid', expected: null }
  ];

  let allPassed = true;
  cases.forEach((c, idx) => {
    const got = parseWeightFromVolume(c.input);
    const passed = got === c.expected;
    console.log(`Parser Test ${idx + 1}: input "${c.input}" -> got ${got}kg, expected ${c.expected}kg`);
    if (passed) {
      console.log('✅ PASSED');
    } else {
      console.log('❌ FAILED');
      allPassed = false;
    }
  });
  console.log();
  return allPassed;
};

const runTests = () => {
  const parserPassed = runVolumeParserTests();

  console.log('=== Running Shipping Calculation Unit Tests ===\n');
  let passedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const result = calculateShippingPure(tc.items);
    
    console.log(`Test ${i + 1}: ${tc.description}`);
    console.log(`Calculated: Subtotal: ₹${result.subtotal}, Weight: ${result.totalWeight}kg, Base: ₹${result.baseShipping}, Extra: ₹${result.extraWeightCharge}, Shipping: ₹${result.shipping}, Total: ₹${result.grandTotal}`);
    
    const shippingMatched = result.shipping === tc.expectedShipping;
    const totalMatched = result.grandTotal === tc.expectedGrandTotal;

    if (shippingMatched && totalMatched) {
      console.log('✅ PASSED\n');
      passedCount++;
    } else {
      console.log('❌ FAILED');
      if (!shippingMatched) {
        console.log(`  Expected Shipping: ₹${tc.expectedShipping}, Got: ₹${result.shipping}`);
      }
      if (!totalMatched) {
        console.log(`  Expected Grand Total: ₹${tc.expectedGrandTotal}, Got: ₹${result.grandTotal}`);
      }
      console.log();
      failedCount++;
    }
  }

  console.log(`=== Summary: ${passedCount} passed, ${failedCount} failed ===`);
  
  if (failedCount > 0 || !parserPassed) {
    process.exit(1);
  } else {
    process.exit(0);
  }
};

runTests();
