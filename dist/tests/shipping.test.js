"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const shippingCalculator_1 = require("../utils/shippingCalculator");
/** 200g threshold / free over ₹1000 — the worked example from the spec. */
const SPEC_CONFIG = {
    ...shippingCalculator_1.DEFAULT_SHIPPING_CONFIG,
    WEIGHT_THRESHOLD_KG: 0.2,
    FREE_SHIPPING_THRESHOLD: 1000,
};
const testCases = [
    {
        description: 'Scenario 1: ₹450 subtotal, 400g weight (Weight <= 500g -> Base shipping ₹40, no extra weight)',
        items: [{ price: 450, weight: 0.4, quantity: 1 }],
        expectedShipping: 40,
        expectedGrandTotal: 490,
    },
    {
        description: 'Scenario 2: ₹450 subtotal, 499g weight (strictly BELOW 500g -> ₹40)',
        items: [{ price: 450, weight: 0.499, quantity: 1 }],
        expectedShipping: 40,
        expectedGrandTotal: 490,
    },
    {
        description: 'Scenario 2a: ₹450 subtotal, EXACTLY 500g (at threshold -> ₹80, not ₹40)',
        items: [{ price: 450, weight: 0.5, quantity: 1 }],
        expectedShipping: 80,
        expectedGrandTotal: 530,
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
    },
    // ── Cart aggregate: the threshold tests the SUM, never a single line ──────
    {
        description: 'Aggregate: 3 x 80g (=240g) crosses the 200g threshold -> ₹80',
        items: [{ price: 100, weight: 0.08, quantity: 3 }],
        expectedShipping: 80,
        expectedGrandTotal: 380,
        config: SPEC_CONFIG,
        expectedWeight: 0.24,
    },
    {
        description: 'Aggregate: two different lines 150g + 90g (=240g) -> ₹80',
        items: [
            { price: 100, weight: 0.15, quantity: 1 },
            { price: 100, weight: 0.09, quantity: 1 },
        ],
        expectedShipping: 80,
        expectedGrandTotal: 280,
        config: SPEC_CONFIG,
        expectedWeight: 0.24,
    },
    {
        description: 'Aggregate: 2 x 80g (=160g) stays under 200g -> ₹40',
        items: [{ price: 100, weight: 0.08, quantity: 2 }],
        expectedShipping: 40,
        expectedGrandTotal: 240,
        config: SPEC_CONFIG,
        expectedWeight: 0.16,
    },
    // ── Missing / malformed weights must not produce NaN ──────────────────────
    {
        description: 'Missing weight (undefined) defaults to 0g -> below threshold -> ₹40',
        items: [{ price: 300, weight: undefined, quantity: 2 }],
        expectedShipping: 40,
        expectedGrandTotal: 640,
        config: SPEC_CONFIG,
        expectedWeight: 0,
    },
    {
        description: 'Mixed: one weighed 150g item + one weightless item -> 150g -> ₹40',
        items: [
            { price: 100, weight: 0.15, quantity: 1 },
            { price: 100, weight: undefined, quantity: 1 },
        ],
        expectedShipping: 40,
        expectedGrandTotal: 240,
        config: SPEC_CONFIG,
        expectedWeight: 0.15,
    },
    {
        description: 'Configured fallback weight (100g) is used when weight is missing',
        items: [{ price: 100, weight: undefined, quantity: 3 }],
        expectedShipping: 80,
        expectedGrandTotal: 380,
        config: { ...SPEC_CONFIG, FALLBACK_ITEM_WEIGHT_KG: 0.1 },
        expectedWeight: 0.3,
    },
    // ── Free shipping tier ────────────────────────────────────────────────────
    {
        description: 'Free shipping: ₹1000 subtotal at the ₹1000 threshold -> shipping ₹0',
        items: [{ price: 1000, weight: 2.0, quantity: 1 }],
        expectedShipping: 0,
        expectedGrandTotal: 1000,
        config: SPEC_CONFIG,
        expectedFreeShipping: true,
    },
    {
        description: 'Free shipping: ₹999 subtotal is just below -> still charged',
        items: [{ price: 999, weight: 0.1, quantity: 1 }],
        expectedShipping: 40,
        expectedGrandTotal: 1039,
        config: SPEC_CONFIG,
        expectedFreeShipping: false,
    },
    {
        description: 'Free shipping disabled (threshold 0) -> never free, however large',
        items: [{ price: 99999, weight: 0.1, quantity: 1 }],
        expectedShipping: 40,
        expectedGrandTotal: 100039,
        config: { ...SPEC_CONFIG, FREE_SHIPPING_THRESHOLD: 0 },
        expectedFreeShipping: false,
    },
    // ── Empty cart ────────────────────────────────────────────────────────────
    {
        description: 'Empty cart -> no shipping charged',
        items: [],
        expectedShipping: 0,
        expectedGrandTotal: 0,
    },
];
const runVolumeParserTests = () => {
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
        const got = (0, shippingCalculator_1.parseWeightFromVolume)(c.input);
        const passed = got === c.expected;
        console.log(`Parser Test ${idx + 1}: input "${c.input}" -> got ${got}kg, expected ${c.expected}kg`);
        if (passed) {
            console.log('✅ PASSED');
        }
        else {
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
        const result = (0, shippingCalculator_1.calculateShippingPure)(tc.items, tc.config);
        console.log(`Test ${i + 1}: ${tc.description}`);
        console.log(`Calculated: Subtotal: ₹${result.subtotal}, Weight: ${result.totalWeight}kg, Base: ₹${result.baseShipping}, Extra: ₹${result.extraWeightCharge}, Shipping: ₹${result.shipping}, Total: ₹${result.grandTotal}`);
        const shippingMatched = result.shipping === tc.expectedShipping;
        const totalMatched = result.grandTotal === tc.expectedGrandTotal;
        const weightMatched = tc.expectedWeight === undefined || result.totalWeight === tc.expectedWeight;
        const freeMatched = tc.expectedFreeShipping === undefined || result.freeShippingApplied === tc.expectedFreeShipping;
        if (shippingMatched && totalMatched && weightMatched && freeMatched) {
            console.log('✅ PASSED\n');
            passedCount++;
        }
        else {
            console.log('❌ FAILED');
            if (!shippingMatched) {
                console.log(`  Expected Shipping: ₹${tc.expectedShipping}, Got: ₹${result.shipping}`);
            }
            if (!totalMatched) {
                console.log(`  Expected Grand Total: ₹${tc.expectedGrandTotal}, Got: ₹${result.grandTotal}`);
            }
            if (!weightMatched) {
                console.log(`  Expected Weight: ${tc.expectedWeight}kg, Got: ${result.totalWeight}kg`);
            }
            if (!freeMatched) {
                console.log(`  Expected freeShippingApplied: ${tc.expectedFreeShipping}, Got: ${result.freeShippingApplied}`);
            }
            console.log();
            failedCount++;
        }
    }
    console.log(`=== Summary: ${passedCount} passed, ${failedCount} failed ===`);
    if (failedCount > 0 || !parserPassed) {
        process.exit(1);
    }
    else {
        process.exit(0);
    }
};
runTests();
//# sourceMappingURL=shipping.test.js.map