/* Standalone tests for expense category helpers.
   Run: node execution/test_expense_categories.mjs   (exit 0 = pass) */
import assert from 'node:assert/strict';
import { categoryOptions, normaliseNewCategory, categoryStyle } from '../src/utils/expenseCategories.js';

const BUILT = ['Fuel', 'Salary - Brad', 'General'];
const exp = cats => cats.map(category => ({ category }));
const GREY = { bg: '#f1f5f9', color: '#475569' };

// ordering: built-ins first (given order), extras A-Z
assert.deepEqual(categoryOptions(BUILT, exp(['Zeta', 'Alpha', 'Fuel'])), ['Fuel', 'Salary - Brad', 'General', 'Alpha', 'Zeta']);
// case-insensitive de-dupe, built-in spelling wins, first extra spelling wins
assert.deepEqual(categoryOptions(BUILT, exp(['fuel', 'FUEL', 'Salary - Sam', 'salary - sam'])), ['Fuel', 'Salary - Brad', 'General', 'Salary - Sam']);
// blanks / whitespace / missing ignored, extras trimmed
assert.deepEqual(categoryOptions(BUILT, exp(['', '   ', null, undefined, '  Rent  '])), ['Fuel', 'Salary - Brad', 'General', 'Rent']);
assert.deepEqual(categoryOptions(BUILT, []), BUILT);
assert.deepEqual(categoryOptions(BUILT, undefined), BUILT);

// normaliseNewCategory
const ex = ['Fuel', 'Salary - John'];
assert.equal(normaliseNewCategory('  Rent  ', ex), 'Rent');
assert.equal(normaliseNewCategory('Office    Rent \t Q1', ex), 'Office Rent Q1');
assert.equal(normaliseNewCategory('salary - john', ex), 'Salary - John');
assert.equal(normaliseNewCategory('x'.repeat(60), ex), 'x'.repeat(40));
assert.equal(normaliseNewCategory('   ', ex), '');
assert.equal(normaliseNewCategory('', ex), '');
assert.equal(normaliseNewCategory(undefined, ex), '');

// categoryStyle
assert.deepEqual(categoryStyle('Fuel'), { bg: '#fff7ed', color: '#c2410c' });
for (const n of ['Salary - Jema', 'Salary - Tomer', 'Salary - John']) {
  assert.deepEqual(categoryStyle(n), categoryStyle('Salary - Brad'));
}
assert.deepEqual(categoryStyle('Rent'), categoryStyle('Rent'));
assert.deepEqual(categoryStyle('Rent'), categoryStyle('rent'));
const pal = new Set(['Rent', 'Phone', 'Tax', 'Parking', 'Training', 'Uniforms', 'Tolls', 'Rego'].map(n => JSON.stringify(categoryStyle(n))));
assert.ok(pal.size > 1, 'different unknown names can differ');
for (const n of ['Rent', 'Phone']) {
  const s = categoryStyle(n);
  assert.match(s.bg, /^#[0-9a-f]{6}$/i); assert.match(s.color, /^#[0-9a-f]{6}$/i);
}
assert.deepEqual(categoryStyle(''), GREY);
assert.deepEqual(categoryStyle(null), GREY);
assert.deepEqual(categoryStyle(undefined), GREY);

console.log('PASS — expenseCategories');
