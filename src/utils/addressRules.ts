import { zoneOfState } from './checkoutSettings';

/**
 * Indian delivery-address checks shared by the address API (save / edit) and payment. Delivery is priced by state
 * (Kerala vs elsewhere), so a PIN code that contradicts the Kerala boundary would be priced for the wrong zone. The
 * address is never changed: the customer is told what to fix.
 *
 * India Post: every Kerala PIN starts with 67, 68 or 69. That PIN circle also serves Mahé (Puducherry, 6733xx) and
 * Lakshadweep (6825xx), so those two are the only non-Kerala states accepted with a 67-69 PIN.
 * ponytail: only the Kerala boundary is checked (the only one that changes the price); a full PIN-to-state table
 * would be needed to validate every other state.
 */
type Addr = { street?: unknown; apartment?: unknown; city?: unknown; state?: unknown; zipCode?: unknown; country?: unknown };

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const inIndia = (country: unknown) => !text(country) || /^(india|in|bharat)$/i.test(text(country));

/** '' when the address is consistent, else one clear sentence for the customer. */
export const addressProblem = (a: Addr): string => {
  if (!inIndia(a.country)) return '';
  const pin = text(a.zipCode).replace(/\s+/g, '');
  const state = text(a.state);
  if (!/^[1-9]\d{5}$/.test(pin)) return 'Enter a valid 6-digit PIN code.';
  const keralaPin = /^6[7-9]/.test(pin);
  if (zoneOfState(state) === 'kerala') {
    return keralaPin ? '' : `PIN code ${pin} is not a Kerala PIN code (Kerala PIN codes start with 67, 68 or 69). Please check the state or PIN code.`;
  }
  if (keralaPin && !(/^(puducherry|pondicherry)$/i.test(state) && pin.startsWith('6733')) && !(/^lakshadweep$/i.test(state) && pin.startsWith('6825'))) {
    return `PIN code ${pin} is a Kerala PIN code, but the state is "${state}". Please check the state or PIN code.`;
  }
  return '';
};

/** Same address for duplicate detection: case, spacing and an empty/"India" country do not matter. */
export const addressKey = (a: Addr) => [a.street, a.apartment, a.city, a.state, a.zipCode].map((v) => text(v).toLowerCase().replace(/\s+/g, ' '))
  .concat(inIndia(a.country) ? 'india' : text(a.country).toLowerCase()).join('|');
