// Pure helpers for expense categories (no React / import.meta).

const MAX_LEN = 40;
const GREY = { bg: '#f1f5f9', color: '#475569' };
const SALARY = { bg: '#eff6ff', color: '#2563eb' };

const KNOWN_STYLES = {
  'Salary - Brad':               SALARY,
  'Salary - Alon':               SALARY,
  'Salary - Yuvi':               SALARY,
  'Salary - Rahda':              SALARY,
  'Salary - Joy':                SALARY,
  'Salary - Omri':               SALARY,
  'Salary - Jema':               SALARY,
  'Salary - Tomer':              SALARY,
  'Salary - John':               SALARY,
  'Fuel':                        { bg: '#fff7ed', color: '#c2410c' },
  'Cleaning Supplies/Equipment': { bg: '#f0fdf4', color: '#15803d' },
  'Advertising':                 { bg: '#fdf4ff', color: '#9333ea' },
  'Marketing':                   { bg: '#fdf2f8', color: '#db2777' },
  'Insurance':                   { bg: '#fef9c3', color: '#a16207' },
  'General':                     GREY,
};

const PALETTE = [
  { bg: '#ecfeff', color: '#0e7490' },
  { bg: '#f0fdfa', color: '#0f766e' },
  { bg: '#fef2f2', color: '#b91c1c' },
  { bg: '#f5f3ff', color: '#6d28d9' },
  { bg: '#fffbeb', color: '#b45309' },
  { bg: '#f7fee7', color: '#4d7c0f' },
  { bg: '#eef2ff', color: '#4338ca' },
  { bg: '#fff1f2', color: '#be123c' },
];

const clean = s => (typeof s === 'string' ? s.trim() : '');

export function categoryOptions(builtIn, expenses) {
  const seen = new Set(builtIn.map(c => c.toLowerCase()));
  const extras = [];
  for (const e of expenses || []) {
    const c = clean(e && e.category);
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    extras.push(c);
  }
  extras.sort((a, b) => a.localeCompare(b));
  return [...builtIn, ...extras];
}

export function normaliseNewCategory(input, existing) {
  const name = clean(input).replace(/\s+/g, ' ').slice(0, MAX_LEN).trim();
  if (!name) return '';
  const hit = (existing || []).find(c => c.toLowerCase() === name.toLowerCase());
  return hit || name;
}

export function categoryStyle(name) {
  if (!name) return GREY;
  if (KNOWN_STYLES[name]) return KNOWN_STYLES[name];
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
