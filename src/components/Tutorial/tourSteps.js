// ── Tour step definitions ─────────────────────────────────────────────────────
// Each step describes one stop in the guided spotlight tour.
//
//   target    CSS selector of the element to highlight, or null for a centered
//             card (welcome / finish). The tour grabs the FIRST match.
//   page      currentPage the app must be on before the step shows. The tour
//             calls setCurrentPage(page) and waits a tick for it to render.
//   title     short heading
//   body      1–2 sentence explanation (plain text, optional if bullets carry it)
//   bullets   optional list of points. Each item is either a plain string, or
//             { label, text } rendered as "**label** — text".
//   tip       optional highlighted callout (a pro-tip / gotcha)
//   placement  where the tooltip sits relative to the target:
//             'right' | 'left' | 'top' | 'bottom' | 'center'
//   openSidebar  on mobile, open the off-canvas sidebar before measuring (nav steps)
//
// The tour is Next-driven — the user never has to click the real element, so the
// highlighted control does not need to be reachable through the dimmed overlay.

const tourSteps = [
  {
    target: null,
    page: 'leads',
    placement: 'center',
    title: 'Welcome to Pearl View 👋',
    body: 'This is your command center for the window-cleaning business. Every web-form inquiry and phone call is captured here automatically, so nothing slips through the cracks. This quick walkthrough shows how a lead travels from first contact all the way to a paid, completed job — and where to track the money along the way.',
    bullets: [
      { label: 'Capture', text: 'leads arrive from your two websites and phone line' },
      { label: 'Work', text: 'move each one through the pipeline to a booking' },
      { label: 'Complete', text: 'mark the job done, record payment, send the invoice' },
      { label: 'Measure', text: 'see revenue, expenses and trends in Reports' },
    ],
    tip: 'It takes about a minute. You can press Skip anytime, or replay it later from the “?” button in the top bar.',
  },
  {
    target: '[data-tour="sidebar"]',
    page: 'leads',
    placement: 'right',
    openSidebar: true,
    title: 'Your navigation',
    body: 'Every part of the business lives in this menu. Here\'s what each section is for:',
    bullets: [
      { label: 'Overview', text: 'daily snapshot of leads, calls and quotes' },
      { label: 'Leads', text: 'the pipeline — your main workspace' },
      { label: 'Clients', text: 'customer directory, built from your leads' },
      { label: 'Calendar', text: 'scheduled jobs by date' },
      { label: 'Expenses', text: 'business costs by category' },
      { label: 'Reports', text: 'revenue and performance analytics' },
      { label: 'Contacts / Broadcast', text: 'SMS list and campaigns' },
    ],
    tip: 'On a phone this menu is hidden — tap the ☰ icon (top-left) to open it.',
  },
  {
    target: '[data-tour="nav-overview"]',
    page: 'overview',
    placement: 'right',
    openSidebar: true,
    title: 'Overview — your daily pulse',
    body: 'Start each day here for an at-a-glance read on how the business is tracking. The cards show today\'s activity, and the sparklines show the trend over recent days.',
    bullets: [
      { label: 'New Leads', text: 'fresh inquiries waiting to be actioned' },
      { label: 'Calls Received', text: 'how many came in by phone vs web form' },
      { label: 'Pending Quotes', text: 'quotes sent, still awaiting a decision' },
      { label: 'Refused', text: 'leads that didn\'t convert, with reasons' },
    ],
  },
  {
    target: '[data-tour="pipeline"]',
    page: 'leads',
    placement: 'top',
    title: 'The lead pipeline',
    body: 'The heart of the app. Each lead is a card that moves left-to-right through five stages — the column header shows how many sit in each:',
    bullets: [
      { label: 'New Lead', text: 'just arrived, not yet contacted' },
      { label: 'In Progress', text: 'you\'ve made contact / are following up' },
      { label: 'Quote Sent', text: 'a price has been given, awaiting reply' },
      { label: 'Booked', text: 'job is scheduled on the calendar' },
      { label: 'Job Done', text: 'work completed (and ideally paid)' },
    ],
    tip: 'A lead can also be marked Refused if it doesn\'t convert — you\'ll be asked for a reason so you can learn what\'s losing business.',
  },
  {
    target: '[data-tour="lead-card"]',
    page: 'leads',
    placement: 'right',
    title: 'A lead card',
    body: 'Each card summarises one inquiry — name, source (Call or Form), estimated value, and how long it\'s been waiting. The coloured aging badge on New leads nudges you to respond fast.',
    bullets: [
      { label: 'Tap the card', text: 'opens the full detail panel' },
      { label: 'Swipe right / left (mobile)', text: 'advance or move back a stage' },
      { label: 'Drag (desktop)', text: 'drop it into another column' },
      { label: 'Star ⭐', text: 'flag a high-priority lead' },
    ],
    tip: 'Green badge = fresh, amber = getting old, red = overdue. Aim to reply while it\'s still green.',
  },
  {
    target: '[data-tour="lead-card"]',
    page: 'leads',
    placement: 'right',
    title: 'Moving a lead forward',
    body: 'The app asks for the right information at the right moment, so your records stay complete without extra admin. As you advance a lead it will prompt you:',
    bullets: [
      { label: '→ Quote Sent', text: 'enter the quote amount' },
      { label: '→ Booked', text: 'pick the date, time and assigned worker' },
      { label: '→ Job Done', text: 'review and send the invoice' },
      { label: '→ Refused', text: 'choose a reason (too expensive, went elsewhere…)' },
    ],
  },
  {
    target: '[data-tour="lead-card"]',
    page: 'leads',
    placement: 'right',
    title: 'Inside a lead',
    body: 'Tapping a card opens the detail panel — the full record for that customer. From here you can manage everything about the job in one place:',
    bullets: [
      'Edit name, phone, email, address and property type',
      'Set the quote amount and scheduled cleaning date',
      'Add private notes for follow-up',
      'Record a payment, and play back the call recording for phone leads',
    ],
    tip: 'Once a job is Done and paid, its status locks to protect your records — delete the payment first if you ever need to change it.',
  },
  {
    target: '[data-tour="search"]',
    page: 'leads',
    placement: 'bottom',
    title: 'Search',
    body: 'Find anyone instantly by name, phone number or email — no scrolling through columns. The search is context-aware: it filters leads on the Leads page and clients on the Clients page.',
  },
  {
    target: '[data-tour="new-lead"]',
    page: 'leads',
    placement: 'bottom',
    title: 'Add a lead manually',
    body: 'Most leads arrive automatically, but use this to log one by hand — perfect for a walk-in, a referral, or a call you took on the go.',
    bullets: [
      'Capture name, phone, email and the inquiry subject',
      'Pick the source (website, phone, Facebook, Google, other)',
      'It drops straight into the New column, ready to work',
    ],
  },
  {
    target: '[data-tour="notifications"]',
    page: 'leads',
    placement: 'bottom',
    title: 'New-lead alerts',
    body: 'The bell flags today\'s fresh leads — both calls and form submissions you haven\'t actioned yet. The number badge shows how many are unseen.',
    bullets: [
      'Click a notification to jump straight to that lead',
      'The count resets each new day so you start clean',
    ],
    tip: 'You also get a WhatsApp message the moment a new lead comes in, so you\'re covered even when the dashboard is closed.',
  },
  {
    target: '[data-tour="nav-clients"]',
    page: 'clients',
    placement: 'right',
    openSidebar: true,
    title: 'Clients',
    body: 'Your customer directory, built automatically from your leads — no double entry. Each profile keeps their contact details and history together.',
    bullets: [
      'Phone, email and address stay in sync with the lead',
      'See how many jobs / leads each customer has',
      'Repeat customers are always one search away',
    ],
  },
  {
    target: '[data-tour="nav-calendar"]',
    page: 'calendar',
    placement: 'right',
    openSidebar: true,
    title: 'Calendar & bookings',
    body: 'Every booked job appears here on its scheduled date, so you can see your week at a glance and avoid double-booking. When the work is finished, mark it complete right from the calendar:',
    bullets: [
      { label: 'Job Done + Record Payment', text: 'marks it paid and logs the revenue' },
      { label: 'Job Done — Collect Later', text: 'completes it but flags payment as outstanding' },
    ],
    tip: 'Completing a job here can automatically generate and email the invoice — and it keeps the matching lead in sync, so the pipeline and calendar never disagree.',
  },
  {
    target: '[data-tour="nav-expenses"]',
    page: 'expenses',
    placement: 'right',
    openSidebar: true,
    title: 'Expenses',
    body: 'Log every business cost here so your profit figures stay honest. Group spending by category to see where the money goes:',
    bullets: [
      'Fuel, supplies, ads, salaries, insurance and general',
      'Each entry has a date, amount and description',
      'Totals feed straight into your Reports',
    ],
  },
  {
    target: '[data-tour="nav-reports"]',
    page: 'reports',
    placement: 'right',
    openSidebar: true,
    title: 'Reports',
    body: 'The big picture: revenue, lead sources and conversion trends over any week, month, year, or a custom range. This is where the numbers come together.',
    bullets: [
      'Which sources (website, phone, ads) bring the best leads',
      'Revenue vs expenses to see real profit',
      'Conversion rates across the pipeline stages',
    ],
    tip: 'Only completed, paid jobs count as income — a payment taken before a job is finished is held separately until you mark it done.',
  },
  {
    target: '[data-tour="nav-contacts"]',
    page: 'contacts',
    placement: 'right',
    openSidebar: true,
    title: 'Contacts & Broadcast SMS',
    body: 'Keep a marketing contact list and reach your customers directly by text — great for seasonal offers, reminders and promotions.',
    bullets: [
      { label: 'Contacts', text: 'import, export and manage your SMS list' },
      { label: 'Broadcast SMS', text: 'compose and send a campaign to everyone at once' },
    ],
    tip: 'The composer counts characters and warns when a message spills into a second text, so you keep sends cheap.',
  },
  {
    target: '[data-tour="help"]',
    page: 'leads',
    placement: 'bottom',
    title: 'That\'s the tour! 🎉',
    body: 'You now know the whole flow: capture a lead, work it through the pipeline, book it, complete the job, get paid, and watch the results in Reports.',
    bullets: [
      'Leads and calls land automatically — just keep the pipeline moving',
      'Let the prompts capture quotes, bookings and invoices for you',
      'Check Overview daily and Reports weekly',
    ],
    tip: 'Need a refresher? Click this “?” button anytime to run the tour again.',
  },
];

export default tourSteps;
