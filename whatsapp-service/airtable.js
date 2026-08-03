const axios = require('axios');

const BASE_URL = 'https://api.airtable.com/v0';

/**
 * Fetch all records from the Leads table and return structured stats
 * for the AI assistant context
 */
async function getLeadsContext() {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableId = process.env.AIRTABLE_TABLE_ID;

  // Fetch all leads (paginate through all pages)
  let allRecords = [];
  let offset = null;

  do {
    const params = {
      pageSize: 100,
      fields: [
        'Client Name',
        'Lead Status',
        'Quote Amount',
        'Final Invoice Amount',
        'Inquiry Date',
        'Lead Source',
        'Refusal Reason',
        'Phone Number',
      ],
    };
    if (offset) params.offset = offset;

    const res = await axios.get(`${BASE_URL}/${baseId}/${tableId}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    });

    allRecords = allRecords.concat(res.data.records || []);
    offset = res.data.offset || null;
  } while (offset);

  // Build stats
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const leads = allRecords.map(r => r.fields);

  // Status breakdown
  const statusCount = {};
  // Source breakdown
  const sourceCount = {};
  // Revenue (Job Done only)
  let totalRevenue = 0;
  let totalQuoted = 0;
  // Recent leads (last 7 days)
  const recentLeads = [];
  // Refusal reasons
  const refusalReasons = [];

  for (const lead of leads) {
    const status = lead['Lead Status'] || 'Unknown';
    statusCount[status] = (statusCount[status] || 0) + 1;

    const source = lead['Lead Source'] || 'Unknown';
    sourceCount[source] = (sourceCount[source] || 0) + 1;

    if (status === 'Job Done') {
      totalRevenue += parseFloat(lead['Final Invoice Amount'] || lead['Quote Amount'] || 0);
    }
    totalQuoted += parseFloat(lead['Quote Amount'] || 0);

    if (lead['Refusal Reason']) {
      refusalReasons.push(lead['Refusal Reason']);
    }

    const inquiryDate = lead['Inquiry Date'] ? new Date(lead['Inquiry Date']) : null;
    if (inquiryDate && inquiryDate >= sevenDaysAgo) {
      recentLeads.push({
        name: lead['Client Name'] || 'Unknown',
        status,
        source,
        date: inquiryDate.toLocaleDateString('en-AU'),
      });
    }
  }

  // Last 100 leads compact list
  const last100 = leads.slice(-100).map(l =>
    `${l['Client Name'] || '?'} | ${l['Lead Status'] || '?'} | $${l['Final Invoice Amount'] || l['Quote Amount'] || 0} | ${l['Lead Source'] || '?'}`
  );

  return {
    totalLeads: leads.length,
    totalRevenue: totalRevenue.toFixed(2),
    totalQuoted: totalQuoted.toFixed(2),
    statusBreakdown: statusCount,
    sourceBreakdown: sourceCount,
    recentLeads,
    refusalReasons,
    last100,
  };
}

module.exports = { getLeadsContext };
