const PRIORITY_MAP = { 1: 4, 2: 3, 3: 2, 4: 1 };
const STATUS_MAP = { 1: 2, 2: 2, 3: 3, 6: 4, 7: 5 };
const IMPACT_MAP = { 1: 3, 2: 2, 3: 1 };
const URGENCY_MAP = { 1: 3, 2: 2, 3: 1 };
const SOURCE_MAP = {
  phone: 3,
  'self-service': 2,
  email: 1,
  'walk-in': 6,
  chat: 4,
  web: 2,
  portal: 2,
};

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
 * Maps a ServiceNow incident record to a Freshservice ticket payload.
 *
 * @param {object} snow - Raw ServiceNow incident record (sysparm_display_value=all)
 * @param {object} [context={}] - Resolution maps built by the worker before migration
 * @param {Map<string, number>} [context.agentEmailToId]     - SN assigned_to display name/email → FS agent ID
 * @param {Map<string, number>} [context.groupNameToId]      - SN assignment_group display name → FS group ID
 * @param {Map<string, number>} [context.requesterEmailToId] - SN caller_id display name/email → FS requester ID
 * @param {Map<string, number>} [context.deptIdMap]          - SN company sys_id → FS department ID
 * @returns {object} Freshservice ticket creation payload
 */
export function mapIncident(snow, context = {}) {
  const {
    agentEmailToId = new Map(),
    groupNameToId = new Map(),
    requesterEmailToId = new Map(),
    deptIdMap = new Map(),
  } = context;

  const mapped = {
    subject: val(snow.short_description) || `Incident ${val(snow.number)}`,
    description: val(snow.description) || val(snow.short_description) || '-',
    priority: PRIORITY_MAP[Number(val(snow.priority))] ?? 2,
    status: STATUS_MAP[Number(val(snow.state))] ?? 2,
  };

  const impact = Number(val(snow.impact));
  if (IMPACT_MAP[impact]) mapped.impact = IMPACT_MAP[impact];

  const urgency = Number(val(snow.urgency));
  if (URGENCY_MAP[urgency]) mapped.urgency = URGENCY_MAP[urgency];

  const category = displayVal(snow.category);
  if (category) mapped.category = category;

  const subCategory = displayVal(snow.subcategory);
  if (subCategory) mapped.sub_category = subCategory;

  const sourceKey = val(snow.contact_type)?.toLowerCase();
  const source = SOURCE_MAP[sourceKey];
  if (source) mapped.source = source;

  const openedAt = toISO(snow.opened_at);
  if (openedAt) mapped.created_at = openedAt;

  const updatedAt = toISO(snow.sys_updated_on);
  if (updatedAt) mapped.updated_at = updatedAt;

  const dueDate = toISO(snow.due_date);
  if (dueDate) mapped.due_by = dueDate;

  const resolvedAt = toISO(snow.resolved_at);
  if (resolvedAt) mapped.resolved_at = resolvedAt;

  const closedAt = toISO(snow.closed_at);
  if (closedAt) mapped.closed_at = closedAt;

  // responder_id — resolve assigned_to via agentEmailToId
  const assignedToKey = displayVal(snow.assigned_to);
  if (assignedToKey) {
    const agentId = agentEmailToId.get(assignedToKey);
    if (agentId !== undefined) mapped.responder_id = agentId;
  }

  // group_id — resolve assignment_group via groupNameToId
  const groupKey = displayVal(snow.assignment_group);
  if (groupKey) {
    const groupId = groupNameToId.get(groupKey);
    if (groupId !== undefined) mapped.group_id = groupId;
  }

  // requester_id — resolve caller_id via requesterEmailToId
  const callerKey = displayVal(snow.caller_id);
  if (callerKey) {
    const requesterId = requesterEmailToId.get(callerKey);
    if (requesterId !== undefined) mapped.requester_id = requesterId;
  }

  // department_id — resolve company sys_id via deptIdMap
  const companySysId = val(snow.company);
  if (companySysId) {
    const deptId = deptIdMap.get(companySysId);
    if (deptId !== undefined) mapped.department_id = deptId;
  }

  mapped.custom_fields = {
    snow_number: val(snow.number) || null,
    close_notes: val(snow.close_notes) || null,
    business_service: displayVal(snow.business_service) || null,
  };

  return mapped;
}

export function getCallerEmail(snow) {
  // 1. Try dedicated dot-walked email field first
  const dotWalked = snow['caller_id.email'];
  if (dotWalked) {
    const raw =
      typeof dotWalked === 'object'
        ? dotWalked.display_value ?? dotWalked.value
        : dotWalked;
    if (raw && raw.includes('@')) return raw;
  }
  // 2. Try caller_id.value — sometimes SN returns email as the value
  const callerField = snow['caller_id'];
  if (typeof callerField === 'object' && callerField?.value?.includes('@')) {
    return callerField.value;
  }
  // 3. No reliable email found — return null, never fall back to hardcoded email
  return null;
}
