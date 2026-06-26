export const COLS = [
  { id: 'new',        label: 'New Lead',    dot: '#0d9488', cnt: '#ccfbf1/#0f766e' },
  { id: 'in_progress',label: 'In Progress', dot: '#d97706', cnt: '#fef3c7/#92400e' },
  { id: 'quote_sent', label: 'Quote Sent',  dot: '#7c3aed', cnt: '#ede9fe/#5b21b6' },
  { id: 'booked',     label: 'Booked',      dot: '#2563eb', cnt: '#dbeafe/#1d4ed8' },
  { id: 'job_done',   label: 'Job Done',    dot: '#16a34a', cnt: '#dcfce7/#14532d' },
  { id: 'refused',    label: 'Refused',     dot: '#dc2626', cnt: '#fee2e2/#991b1b' },
  { id: 'scam',       label: 'Scam',        dot: '#6b7280', cnt: '#f3f4f6/#374151' },
];

export const STATUS_MAP = {
  'New':         'new',
  'New Lead':    'new',
  'In Progress': 'in_progress',
  'Contacted':   'in_progress',
  'Quote Sent':  'quote_sent',
  'Quoted':      'quote_sent',
  'Booked':      'booked',
  'Scheduled':   'booked',
  'Completed':   'job_done',
  'Job Done':    'job_done',
  'Refused':     'refused',
  'Lost':        'refused',
  'Scam':        'scam',
  'Archived':    'archived',
};

export const AT_STATUS_MAP = {
  new:         'New Lead',
  in_progress: 'In Progress',
  quote_sent:  'Quote Sent',
  booked:      'Booked',
  refused:     'Refused',
  job_done:    'Job Done',
  scam:        'Scam',
  archived:    'Archived',
};

export const PROG_MAP = {
  new:         10,
  in_progress: 35,
  quote_sent:  60,
  booked:      80,
  refused:     100,
  job_done:    100,
  scam:        0,
};

export const REFUSE_LABELS = {
  too_expensive: 'Too Expensive',
  competition:   'Competition',
  no_answer:     'No Answer',
  other:         'Other',
};

export const EXPENSE_CATEGORIES = [
  'Salary - Brad',
  'Salary - Alon',
  'Salary - Yuvi',
  'Salary - Rahda',
  'Fuel',
  'Cleaning Supplies/Equipment',
  'Advertising',
  'Marketing',
  'Insurance',
  'General',
];

export const LEAD_SOURCES = [
  'website-pearlview',
  'website-crystalpro',
  'Phone Call',
  'Facebook',
  'Google',
  'Other',
];
