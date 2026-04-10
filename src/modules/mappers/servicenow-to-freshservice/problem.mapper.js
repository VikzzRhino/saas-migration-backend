const PRIORITY_MAP = { 1: 4, 2: 3, 3: 2, 4: 1 };
const STATUS_MAP = { 1: 1, 2: 1, 3: 2, 4: 3 };
const IMPACT_MAP = { 1: 3, 2: 2, 3: 1 };

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

function toISO(dateStr) {
  if (!dateStr) return null;
  const raw = val(dateStr);
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Maps a ServiceNow problem record to a Freshservice problem payload.
 *
 * @param {object} snow - Raw ServiceNow problem record (sysparm_display_value: 'all')
 * @param {object} context - Resolution maps built before migration starts
 * @param {Map<string, number>} context.agentEmailToId     - Agent email/name → FS agent ID
 * @param {Map<string, number>} context.groupNameToId      - Group display name → FS group ID
 * @param {Map<string, number>} context.requesterEmailToId - Requester email/name → FS requester ID
 * @returns {object} Freshservice-compatible problem payload
 */
export function mapProblem(snow, context = {}) {
  const mapped = {
    subject: val(snow.short_description) || `Problem ${snow.number}`,
    description: val(snow.description) || val(snow.short_description) || '-',
    priority: PRIORITY_MAP[Number(val(snow.priority))] ?? 2,
    status: STATUS_MAP[Number(val(snow.state))] ?? 1,
    impact: IMPACT_MAP[Number(val(snow.impact))] ?? 2,
    known_error: val(snow.known_error) === 'true',
  };

  const dueBy = toISO(val(snow.due_date));
  if (dueBy) mapped.due_by = dueBy;

  const category = displayVal(snow.category);
  if (category) mapped.category = category;

  const subCategory = displayVal(snow.subcategory);
  if (subCategory) mapped.sub_category = subCategory;

  const openedAt = toISO(snow.opened_at);
  if (openedAt) mapped.created_at = openedAt;

  const updatedAt = toISO(snow.sys_updated_on);
  if (updatedAt) mapped.updated_at = updatedAt;

  // agent_id — resolve assigned_to display_value against agentEmailToId
  const assignedToDisplay = displayVal(snow.assigned_to);
  if (assignedToDisplay && context.agentEmailToId) {
    const agentId = context.agentEmailToId.get(assignedToDisplay);
    if (agentId !== undefined) mapped.agent_id = agentId;
  }

  // group_id — resolve assignment_group display_value against groupNameToId
  const groupDisplay = displayVal(snow.assignment_group);
  if (groupDisplay && context.groupNameToId) {
    const groupId = context.groupNameToId.get(groupDisplay);
    if (groupId !== undefined) mapped.group_id = groupId;
  }

  // requester_id — resolve opened_by display_value against requesterEmailToId
  const openedByDisplay = displayVal(snow.opened_by);
  if (openedByDisplay && context.requesterEmailToId) {
    const requesterId = context.requesterEmailToId.get(openedByDisplay);
    if (requesterId !== undefined) mapped.requester_id = requesterId;
  }

  // analysis_fields — always included
  mapped.analysis_fields = {
    problem_cause: { description: val(snow.cause_notes) || '' },
    problem_symptom: { description: val(snow.symptoms) || '' },
    problem_impact: { description: val(snow.fix_notes) || '' },
  };

  // custom_fields — traceability back to ServiceNow
  mapped.custom_fields = {
    snow_number: val(snow.number) || null,
    resolution_code: val(snow.resolution_code) || null,
    workaround: val(snow.workaround) || null,
  };

  return mapped;
}
