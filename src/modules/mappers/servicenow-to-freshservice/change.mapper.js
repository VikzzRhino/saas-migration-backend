// ServiceNow priority: 1=Critical, 2=High, 3=Moderate, 4=Low
// Freshservice priority: 1=Low, 2=Medium, 3=High, 4=Urgent
const PRIORITY_MAP = { 1: 4, 2: 3, 3: 2, 4: 1 };

// ServiceNow state: -5=New, -4=Assess, -3=Authorize, -2=Scheduled, -1=Implement, 0=Review, 3=Closed
// Freshservice status: 1=Open, 2=Planning, 3=Awaiting Approval, 4=Pending Release, 5=Closed
const STATUS_MAP = { '-5': 1, '-4': 2, '-3': 3, '-2': 4, '-1': 4, 0: 4, 3: 5 };

// ServiceNow type: standard/normal/emergency → Freshservice change_type: 1=Minor, 2=Standard, 3=Major, 4=Emergency
const CHANGE_TYPE_MAP = { standard: 2, normal: 2, emergency: 4, minor: 1, major: 3 };

// ServiceNow impact: 1=High, 2=Medium, 3=Low → Freshservice impact: 1=Low, 2=Medium, 3=High
const IMPACT_MAP = { 1: 3, 2: 2, 3: 1 };

// ServiceNow risk: 1=High, 2=Medium, 3=Low, 4=Very High → Freshservice risk: 1=Low, 2=Medium, 3=High, 4=Very High
const RISK_MAP = { 1: 3, 2: 2, 3: 1, 4: 4 };

function toISO(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function val(field) {
  return typeof field === 'object' ? field?.value ?? field?.display_value : field;
}

export function mapChange(snow) {
  const now = new Date();
  const startDate = toISO(val(snow.start_date)) ?? now.toISOString();
  const rawEnd = toISO(val(snow.end_date));
  const endDate = rawEnd && new Date(rawEnd) > new Date(startDate)
    ? rawEnd
    : new Date(new Date(startDate).getTime() + 3600000).toISOString();

  const mapped = {
    subject: val(snow.short_description) || `Change ${snow.number}`,
    description: val(snow.description) || val(snow.short_description) || '-',
    priority: PRIORITY_MAP[Number(val(snow.priority))] ?? 2,
    status: STATUS_MAP[String(val(snow.state))] ?? 1,
    change_type: CHANGE_TYPE_MAP[val(snow.type)?.toLowerCase()] ?? 2,
    impact: IMPACT_MAP[Number(val(snow.impact))] ?? 2,
    risk: RISK_MAP[Number(val(snow.risk))] ?? 2,
    planned_start_date: startDate,
    planned_end_date: endDate,
  };

  return mapped;
}
