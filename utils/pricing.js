// ══════════════════════════════════════════════════════
// PRICING — THE SERVER'S SIDE OF THE CALCULATOR
//
// The calculator itself is the client's own module, in public/pricing. It
// works the price out in the browser, which is fine for showing somebody a
// number and not fine for storing one: everything the browser sends can be
// edited on the way. Its README says as much - "if quotes will drive
// invoicing, ask for a server-side check that re-prices the saved quote".
//
// This is that check. It loads the same engine and the same rate list the
// browser used and works the quote out again from the items alone. The
// browser's totals are compared, never trusted, and a quote whose figures do
// not match the rules is refused rather than quietly corrected - a saved
// quote that disagrees with the price list is the kind of thing nobody
// notices until an invoice is argued about.
//
// One copy of the arithmetic, used by both sides. Re-implementing the rules
// here in a second language is how the two start disagreeing.
//
// TWO COPIES OF THE MODULE, ON PURPOSE
//
// public/pricing        the staff calculator, kept up to date
// public/pricing-public the two brand links, frozen where they were
//
// The office is getting its own build for each brand, and until it arrives
// the public links must not move under the people using them. The two are
// the same arithmetic today - the only difference between the versions is
// the screen - but each page is priced by the engine its own browser ran,
// so they cannot drift apart without somebody choosing it.
// ══════════════════════════════════════════════════════
const path = require('path');

/** Load one copy of the module and build the server's side of it. */
function makePricing(folder) {
  const dir = path.join(__dirname, '..', 'public', folder, 'js');
  const rates = require(path.join(dir, 'pricing-rates.js'));
  const { engine } = require(path.join(dir, 'pricing-engine.js'));
  return { rates, engine };
}

function build(folder) {
  const { rates, engine } = makePricing(folder);

// Money is compared to the paisa. The browser and Node both use doubles and
// both run the same code, so they agree - but a rounding difference in the
// last place must not be the thing that refuses somebody's quote.
const EPSILON = 0.01;

  const BRANDS = rates.brands.map(b => b[0]);

/**
 * Work a quote out from its items, here, with no reference to what the
 * browser said the answer was.
 *
 * @param {object} input {brand, additionalDiscount, rushFee, items[]}
 * @returns {object} the engine's result
 */
function price(input) {
  const brand = String((input && input.brand) || '').trim();
  if (BRANDS.indexOf(brand) < 0) throw new Error('Unknown brand: ' + brand);

  const items = Array.isArray(input && input.items) ? input.items : [];
  if (!items.length) throw new Error('A quote needs at least one item.');
  // Guards the memory rather than the arithmetic: the engine would happily
  // work through a list somebody posted with a hundred thousand rows in it.
  if (items.length > 200) throw new Error('Too many items in one quote.');

  const add = Number((input && input.additionalDiscount) || 0);
  if (!Number.isFinite(add) || add < 0 || add > 100) {
    throw new Error('The additional discount has to be between 0 and 100.');
  }

  // The rush fee is a percentage ADDED after both discounts, so it has to be
  // carried through here. Dropping it would not fail loudly - the server
  // would simply work out a smaller balance than the browser showed and
  // refuse the quote as tampered with, on every rush job.
  const rush = Number((input && input.rushFee) || 0);
  if (!Number.isFinite(rush) || rush < 0 || rush > 100) {
    throw new Error('The rush fee has to be between 0 and 100.');
  }

  return engine.calculate(rates, { brand, additionalDiscount: add, rushFee: rush, items });
}

/**
 * Re-price a quote and check the browser agreed.
 *
 * @returns {{ok: true, result: object}} when the figures match
 * @returns {{ok: false, error: string, server: object, sent: object}} when they do not
 */
function verify(input, claimed) {
  const result = price(input);
  const sent = claimed || {};

  const fields = [
    ['total', result.total],
    ['balance', result.balance],
    ['baseDiscount', result.baseDiscountAmount],
    ['additionalDiscount', result.additionalDiscountAmount],
    ['rushFee', result.rushFeeAmount],
  ];

  for (const [name, ours] of fields) {
    // A figure the browser did not send is not a disagreement - it is the
    // server's to fill in. Only a figure that was sent AND differs is.
    if (sent[name] === undefined || sent[name] === null || sent[name] === '') continue;
    const theirs = Number(sent[name]);
    if (!Number.isFinite(theirs) || Math.abs(theirs - ours) > EPSILON) {
      return {
        ok: false,
        error: 'These figures do not match the price list. Please calculate the quote again.',
        field: name,
        server: { total: result.total, balance: result.balance },
        sent: { total: sent.total, balance: sent.balance },
      };
    }
  }

  return { ok: true, result };
}

/** The summary the office pastes to a client, built from the server's own figures. */
function summary(result, who) {
  return engine.summaryText(result, who || {});
}

  return { price, verify, summary, rates, BRANDS, EPSILON };
}

// The staff calculator, and the two public brand links frozen where they
// were until the office sends their own build.
const internal = build('pricing');
const forPublic = build('pricing-public');

module.exports = Object.assign({}, internal, { internal, forPublic });
