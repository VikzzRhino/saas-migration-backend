const PRIORITY_MAP = { 1: 4, 2: 3, 3: 2, 4: 1 };

// SN state comes as display_value strings
const STATUS_MAP = {
  new: 1,
  assess: 1,
  authorize: 1,
  scheduled: 1,
  implement: 2,
  review: 2,
  closed: 3,
  canceled: 4,
  cancelled: 4,
};

const CHANGE_TYPE_MAP = {
  standard: 2,
  normal: 2,
  minor: 1,
  major: 3,
  emergency: 4,
  expedited: 4,
  latent: 1,
};

const RISK_MAP = {
  high: 1,
  '1': 1,
  medium: 2,
  moderate: 2,
  '2': 2,
  low: 3,
  '3': 3,
  'very low': 4,
  very_low: 4,
  '4': 4,
};

const IMPACT_MAP = { 1: 3, 2: 2, 3: 1 };

function toISO(snDate) {
  if (!snDate) return null;
  try {
    const normalized = String(snDate).trim().replace(' ', 'T') + '.000Z';
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function val(field) {
  return typeof field === 'object'
    ? field?.value ?? field?.display_value
    : field;
}

function displayVal(field) {
  return typeof field === 'object'
    ? field?.display_value ?? field?.value
    : field;
}

/**
 * Maps a ServiceNow change record to a Freshservice change payload.
 *
 * @param {object} snow - Raw ServiceNow change record (sysparm_display_value: 'all')
 * @param {object} [context={}] - Resolution maps built before migration starts
 * @param {Map<string, number>} context.agentEmailToId     - SN agent display name → FS agent ID
 * @param {Map<string, number>} context.groupNameToId      - SN group display name → FS group ID
 * @param {Map<string, number>} context.requesterEmailToId - SN requester display name → FS requester ID
 * @returns {object} Freshservice-compatible change payload
 */
export function mapChange(snow, context = {}) {
  const rawSubject = val(snow.short_description);
  const rawDescription = val(snow.description) || val(snow.short_description);

  const mapped = {
    subject: rawSubject || `Change ${val(snow.number)}`,
    description: rawDescription || '<p> </p>',
    priority: PRIORITY_MAP[Number(val(snow.priority))] ?? 2,
    status: STATUS_MAP[String(val(snow.state) ?? '').toLowerCase()] ?? 1,
    change_type: CHANGE_TYPE_MAP[String(snow.type || '').toLowerCase()] ?? 2,
    risk: RISK_MAP[String(val(snow.risk) || '').toLowerCase()] ?? 2,
    impact: IMPACT_MAP[Number(val(snow.impact))] ?? 2,
  };

  const fallbackStart = new Date(Date.now() + 86400000).toISOString();
  const fallbackEnd   = new Date(Date.now() + 172800000).toISOString();
  const startIso = toISO(val(snow.start_date)) ?? fallbackStart;
  const endIso   = toISO(val(snow.end_date))   ?? fallbackEnd;
  mapped.planned_start_date = startIso;
  mapped.planned_end_date   = new Date(endIso) > new Date(startIso)
    ? endIso
    : new Date(new Date(startIso).getTime() + 86400000).toISOString();

  const category = displayVal(snow.category);
  if (category) mapped.category = category;

  const subCategory = displayVal(snow.subcategory);
  if (subCategory) mapped.sub_category = subCategory;

  // agent_id — only when positively resolved
  const assignedToDisplay = displayVal(snow.assigned_to);
  if (assignedToDisplay && context.agentEmailToId) {
    const agentId = context.agentEmailToId.get(assignedToDisplay);
    if (agentId != null) mapped.agent_id = agentId;
  }

  // group_id — only when positively resolved
  const groupDisplay = displayVal(snow.assignment_group);
  if (groupDisplay && context.groupNameToId) {
    const groupId = context.groupNameToId.get(groupDisplay);
    if (groupId != null) mapped.group_id = groupId;
  }

  // requester_id — only when positively resolved
  const requestedByDisplay = displayVal(snow.requested_by);
  if (requestedByDisplay && context.requesterEmailToId) {
    const requesterId = context.requesterEmailToId.get(requestedByDisplay);
    if (requesterId != null) mapped.requester_id = requesterId;
  }

  // Fold SN planning fields into description to preserve data without
  // sending non-standard FS fields (risk, backout_plan, test_plan, etc.)
  const planParts = [];
  const reason = val(snow.reason);
  if (reason) planParts.push(`<h3>Reason</h3><p>${reason}</p>`);
  const justification = val(snow.justification);
  if (justification) planParts.push(`<h3>Justification</h3><p>${justification}</p>`);
  const implPlan = val(snow.implementation_plan);
  if (implPlan) planParts.push(`<h3>Implementation Plan</h3><p>${implPlan}</p>`);
  const backout = val(snow.backout_plan);
  if (backout) planParts.push(`<h3>Backout Plan</h3><p>${backout}</p>`);
  const testPlan = val(snow.test_plan);
  if (testPlan) planParts.push(`<h3>Test Plan</h3><p>${testPlan}</p>`);
  const riskDisplay = displayVal(snow.risk);
  if (riskDisplay) planParts.push(`<h3>Risk</h3><p>${riskDisplay}</p>`);
  if (planParts.length > 0) {
    mapped.description += `<hr/><h2>Planning Details</h2>${planParts.join('')}`;
  }

  return mapped;
}
