// ServiceNow priority: 1=Critical, 2=High, 3=Moderate, 4=Low
// Freshservice priority: 1=Low, 2=Medium, 3=High, 4=Urgent
const PRIORITY_MAP = { 1: 4, 2: 3, 3: 2, 4: 1 };

// ServiceNow state: 1=Open, 2=Known Error, 3=Pending Change, 4=Closed/Resolved
// Freshservice status: 1=Open, 2=Change Requested, 3=Closed
const STATUS_MAP = { 1: 1, 2: 1, 3: 2, 4: 3 };

// ServiceNow impact: 1=High, 2=Medium, 3=Low → Freshservice impact: 1=Low, 2=Medium, 3=High
const IMPACT_MAP = { 1: 3, 2: 2, 3: 1 };

function val(field) {
  return typeof field === 'object' ? field?.value ?? field?.display_value : field;
}

export function mapProblem(snow) {
  const mapped = {
    subject: val(snow.short_description) || `Problem ${snow.number}`,
    description: val(snow.description) || val(snow.short_description) || '-',
    priority: PRIORITY_MAP[Number(val(snow.priority))] ?? 2,
    status: STATUS_MAP[Number(val(snow.state))] ?? 1,
    impact: IMPACT_MAP[Number(val(snow.impact))] ?? 2,
    due_by: val(snow.due_date) ?? null,
  };

  return mapped;
}
