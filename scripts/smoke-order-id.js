/**
 * How a typed order number is read.
 *
 * The office quotes order numbers to each other all day and types them from
 * memory, so the punctuation gets dropped. Every order in the book is K- and
 * then digits - 8,663 of them with no exception - which means the hyphen
 * carries no information and refusing somebody over it is refusing them over
 * nothing.
 *
 * Pure functions, no database, so this runs in a second and can be run on
 * every change to the rule.
 */
const { tidyOrderId, parseOrderIds } = require('../utils/orderId');

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
};
const is = (input, want) => {
  const got = tidyOrderId(input);
  check(JSON.stringify(input) + '  ->  ' + JSON.stringify(want), got === want, got);
};
const list = (input, want) => {
  const got = parseOrderIds(input);
  check(JSON.stringify(input) + '  ->  ' + JSON.stringify(want),
    JSON.stringify(got) === JSON.stringify(want), got);
};

console.log('What the paperwork says');
is('K-160471', 'K-160471');
is('K-160190-R1', 'K-160190-R1');

console.log('\nThe hyphen nobody typed');
is('k160471', 'k-160471');
is('K160471', 'K-160471');
is('K 160471', 'K-160471');
is('k.160471', 'k-160471');

console.log('\nThe space that crept in');
is('k- 160190', 'k-160190');
is('k -160190', 'k-160190');
is('  k160471  ', 'k-160471');

console.log('\nThe number on its own');
// Every order is K-, so there is only one thing a bare number can be.
is('160471', 'K-160471');
is('159971', 'K-159971');

console.log('\nWhat it leaves alone');
is('', '');
// Not an order number, and not this function's business to invent one.
is('abc', 'abc');
check('a number too long to be an order is left alone',
  tidyOrderId('1234567890') === '1234567890', tidyOrderId('1234567890'));

console.log('\nA pasted list');
list('k160471, K-160446; k-159971', ['k-160471', 'K-160446', 'k-159971']);
list('k160471\nk160471\n160446', ['k-160471', 'K-160446']);
list('K-160190   K-160191', ['K-160190', 'K-160191']);

console.log('\nTwo orders with a dash between them');
// The repair leaves this alone on purpose, which used to leave the dash
// itself in the list and report it back as a missing order.
list('K-160190 - K-160191', ['K-160190', 'K-160191']);
list('K-160190 — K-160191', ['K-160190', 'K-160191']);

console.log('\nNothing at all');
list('', []);
list('   ,  ;  ', []);

console.log('\nThe same rule both sides of the wire');
// The Corrections preview loads utils/orderId.js in the browser rather than
// carrying a copy, so this is really a check that the file can be read that
// way at all.
const fs = require('fs');
const src = fs.readFileSync(require.resolve('../utils/orderId'), 'utf8');
check('it hands itself to a browser', /window\.ArabellaOrderId/.test(src));
check('and to Node', /module\.exports/.test(src));
check('and the server offers it at /js/orderId.js',
  /\/js\/orderId\.js/.test(fs.readFileSync(require.resolve('../server.js'), 'utf8')));
check('which the Corrections page loads',
  /src="\/js\/orderId\.js"/.test(fs.readFileSync(__dirname + '/../views/views/corrections.ejs', 'utf8')));
check('and uses instead of its own copy',
  /ArabellaOrderId\.parseOrderIds/.test(fs.readFileSync(__dirname + '/../views/views/corrections.ejs', 'utf8')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
