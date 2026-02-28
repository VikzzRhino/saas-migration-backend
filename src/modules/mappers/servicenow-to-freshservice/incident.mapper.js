// ServiceNow priority: 1=Critical, 2=High, 3=Moderate, 4=Low
// Freshservice priority: 1=Low, 2=Medium, 3=High, 4=Urgent
const PRIORITY_MAP = { 1: 4, 2: 3, 3: 2, 4: 1 };

// ServiceNow state: 1=New, 2=In Progress, 3=On Hold, 6=Resolved, 7=Closed
// Freshservice status: 2=Open, 3=Pending, 4=Resolved, 5=Closed
const STATUS_MAP = { 1: 2, 2: 2, 3: 3, 6: 4, 7: 5 };

function val(field) {
  return typeof field === 'object' ? field?.value ?? field?.display_value : field;
}

export function mapIncident(snow) {
  return {
    subject: val(snow.short_description) || `Incident ${val(snow.number)}`,
    description: val(snow.description) || val(snow.short_description) || '-',
    priority: PRIORITY_MAP[Number(val(snow.priority))] ?? 2,
    status: STATUS_MAP[Number(val(snow.state))] ?? 2,
  };
}

export function getCallerEmail(snow) {
  const raw = snow['caller_id.email'];
  const email = typeof raw === 'object' ? (raw?.display_value ?? raw?.value) : raw;
  return email || null;
}
