"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addressKey = exports.addressProblem = void 0;
const checkoutSettings_1 = require("./checkoutSettings");
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const inIndia = (country) => !text(country) || /^(india|in|bharat)$/i.test(text(country));
/** '' when the address is consistent, else one clear sentence for the customer. */
const addressProblem = (a) => {
    if (!inIndia(a.country))
        return '';
    const pin = text(a.zipCode).replace(/\s+/g, '');
    const state = text(a.state);
    if (!/^[1-9]\d{5}$/.test(pin))
        return 'Enter a valid 6-digit PIN code.';
    const keralaPin = /^6[7-9]/.test(pin);
    if ((0, checkoutSettings_1.zoneOfState)(state) === 'kerala') {
        return keralaPin ? '' : `PIN code ${pin} is not a Kerala PIN code (Kerala PIN codes start with 67, 68 or 69). Please check the state or PIN code.`;
    }
    if (keralaPin && !(/^(puducherry|pondicherry)$/i.test(state) && pin.startsWith('6733')) && !(/^lakshadweep$/i.test(state) && pin.startsWith('6825'))) {
        return `PIN code ${pin} is a Kerala PIN code, but the state is "${state}". Please check the state or PIN code.`;
    }
    return '';
};
exports.addressProblem = addressProblem;
/** Same address for duplicate detection: case, spacing and an empty/"India" country do not matter. */
const addressKey = (a) => [a.street, a.apartment, a.city, a.state, a.zipCode].map((v) => text(v).toLowerCase().replace(/\s+/g, ' '))
    .concat(inIndia(a.country) ? 'india' : text(a.country).toLowerCase()).join('|');
exports.addressKey = addressKey;
//# sourceMappingURL=addressRules.js.map