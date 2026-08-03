/**
 * config.js — per-deployment business identity + branding.
 *
 * Every value defaults to the original Pearl View (NSW) settings, so existing
 * deployments are unchanged. A second location (e.g. Asaf's Perth branch) runs
 * the SAME code and overrides these via Cloud Run env vars — no code fork.
 *
 * Split of names (NSW uses two distinct strings, both preserved as defaults):
 *   BUSINESS.name — legal / bank-account name printed on the invoice + used as
 *                   the Gmail "From" display ("Pearlview Window Cleaning").
 *   BRAND_NAME    — marketing display name in email bodies / booking page
 *                   ("Pearl View Window Cleaning").
 *   BRAND_SHORT   — short brand used in calendar summaries ("Pearl View").
 */

// Multi-line postal address — pipe-separated in env: BUSINESS_ADDRESS="line1|line2".
const address = (process.env.BUSINESS_ADDRESS || '2 bobra Glen|Oceanshores, New South Wales')
  .split('|').map(s => s.trim()).filter(Boolean);

// Identity that prints on the invoice PDF (legal name, bank details, ABN).
const BUSINESS = {
  name:    process.env.BUSINESS_NAME    || 'Pearlview Window Cleaning',
  address,
  phone:   process.env.BUSINESS_PHONE   || '0401 308 180',
  email:   process.env.BUSINESS_EMAIL   || 'service@pearlview.com.au',
  abn:     process.env.BUSINESS_ABN     || '97952792407',
  bsb:     process.env.BUSINESS_BSB     || '067873',
  account: process.env.BUSINESS_ACCOUNT || '23799218',
};

// Marketing / display names.
const BRAND_NAME  = process.env.BRAND_NAME  || 'Pearl View Window Cleaning';
const BRAND_SHORT = process.env.BRAND_SHORT || 'Pearl View';

// Public dashboard URL — shown in WhatsApp lead notifications + the FB alert email.
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://pearl-view-lead-generation-rosy.vercel.app';

// Footer line on the WhatsApp lead notification ("_… lead notification_").
const NOTIFY_FOOTER = process.env.NOTIFY_FOOTER || 'Pearl View lead notification';

// Business timezone — used to render invoice dates + inquiry timestamps. NSW =
// Sydney; a Perth branch sets BUSINESS_TZ=Australia/Perth (AWST, no DST) so a
// late-night call/inquiry never lands on the wrong calendar day.
const TZ = process.env.BUSINESS_TZ || 'Australia/Sydney';

module.exports = { BUSINESS, BRAND_NAME, BRAND_SHORT, DASHBOARD_URL, NOTIFY_FOOTER, TZ };
