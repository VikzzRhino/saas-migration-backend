import { FRESHSERVICE_SCHEMAS, SERVICENOW_TABLE_MAP } from './field-schema.js';

// Known direct mappings: ServiceNow field → Freshservice field (per object type)
const KNOWN_MAPPINGS = {
  incidents: {
    short_description: { target: 'subject', transform: 'direct' },
    description: { target: 'description', transform: 'direct' },
    priority: { target: 'priority', transform: 'priority_map' },
    state: { target: 'status', transform: 'incident_status_map' },
    caller_id: { target: 'requester_id', transform: 'resolve_requester' },
    category: { target: 'category', transform: 'direct' },
    impact: { target: 'impact', transform: 'impact_map' },
    urgency: { target: 'urgency', transform: 'direct' },
    assigned_to: { target: 'responder_id', transform: 'resolve_agent' },
    assignment_group: { target: 'group_id', transform: 'resolve_group' },
    company: { target: 'department_id', transform: 'resolve_department' },
    contact_type: { target: 'source', transform: 'direct' },
    opened_at: { target: 'created_at', transform: 'datetime' },
    sys_created_on: { target: 'created_at', transform: 'datetime' },
    sys_updated_on: { target: 'updated_at', transform: 'datetime' },
    resolved_at: { target: 'closed_at', transform: 'datetime' },
    closed_at: { target: 'closed_at', transform: 'datetime' },
  },
  changes: {
    short_description: { target: 'subject', transform: 'direct' },
    description: { target: 'description', transform: 'direct' },
    priority: { target: 'priority', transform: 'priority_map' },
    state: { target: 'status', transform: 'change_status_map' },
    type: { target: 'change_type', transform: 'change_type_map' },
    impact: { target: 'impact', transform: 'impact_map' },
    risk: { target: 'risk', transform: 'risk_map' },
    start_date: { target: 'planned_start_date', transform: 'datetime' },
    end_date: { target: 'planned_end_date', transform: 'datetime' },
    assignment_group: { target: 'group_id', transform: 'resolve_group' },
    assigned_to: { target: 'agent_id', transform: 'resolve_agent' },
    requested_by: { target: 'requester_id', transform: 'resolve_requester' },
    category: { target: 'category', transform: 'direct' },
    reason: { target: 'planning_reason', transform: 'direct' },
    justification: { target: 'planning_impact', transform: 'direct' },
    implementation_plan: { target: 'planning_rollout', transform: 'direct' },
    backout_plan: { target: 'planning_backout', transform: 'direct' },
    opened_at: { target: 'created_at', transform: 'datetime' },
    sys_updated_on: { target: 'updated_at', transform: 'datetime' },
    closed_at: { target: 'closed_at', transform: 'datetime' },
  },
  problems: {
    short_description: { target: 'subject', transform: 'direct' },
    description: { target: 'description', transform: 'direct' },
    priority: { target: 'priority', transform: 'priority_map' },
    state: { target: 'status', transform: 'problem_status_map' },
    impact: { target: 'impact', transform: 'impact_map' },
    urgency: { target: 'urgency', transform: 'direct' },
    due_date: { target: 'due_by', transform: 'datetime' },
    assigned_to: { target: 'agent_id', transform: 'resolve_agent' },
    assignment_group: { target: 'group_id', transform: 'resolve_group' },
    opened_by: { target: 'requester_id', transform: 'resolve_requester' },
    category: { target: 'category', transform: 'direct' },
    opened_at: { target: 'created_at', transform: 'datetime' },
    sys_updated_on: { target: 'updated_at', transform: 'datetime' },
    closed_at: { target: 'closed_at', transform: 'datetime' },
  },
  users: {
    first_name: { target: 'first_name', transform: 'direct' },
    last_name: { target: 'last_name', transform: 'direct' },
    email: { target: 'primary_email', transform: 'direct' },
    phone: { target: 'work_phone_number', transform: 'direct' },
    mobile_phone: { target: 'mobile_phone_number', transform: 'direct' },
    department: { target: 'department_id', transform: 'resolve_department' },
    title: { target: 'job_title', transform: 'direct' },
    time_zone: { target: 'time_zone', transform: 'direct' },
    vip: { target: 'vip_user', transform: 'direct' },
    location: { target: 'location_id', transform: 'resolve_department' },
  },
  admins: {
    first_name: { target: 'first_name', transform: 'direct' },
    last_name: { target: 'last_name', transform: 'direct' },
    email: { target: 'email', transform: 'direct' },
    phone: { target: 'work_phone_number', transform: 'direct' },
    roles: { target: 'roles', transform: 'admin_roles' },
  },
  companies: {
    name: { target: 'name', transform: 'direct' },
    notes: { target: 'description', transform: 'direct' },
    website: { target: 'domains', transform: 'direct' },
  },
  kb_articles: {
    short_description: { target: 'title', transform: 'direct' },
    text: { target: 'description', transform: 'direct' },
    workflow_state: { target: 'status', transform: 'kb_status_map' },
    sys_tags: { target: 'tags', transform: 'direct' },
  },
};

function normalizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function computeSimilarity(a, b) {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.8;

  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const aSet = bigrams(na);
  const bSet = bigrams(nb);
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const bg of aSet) if (bSet.has(bg)) intersection++;
  return intersection / (aSet.size + bSet.size - intersection);
}

/**
 * Generate auto-mappings for an object type.
 */
export function generateAutoMapping(objectType, sourceFields) {
  const targetSchema = FRESHSERVICE_SCHEMAS[objectType];
  if (!targetSchema) return [];

  const knownMap = KNOWN_MAPPINGS[objectType] ?? {};
  const mappings = [];
  const usedTargetFields = new Set();

  // Phase 1: Apply known direct mappings
  for (const srcField of sourceFields) {
    const known = knownMap[srcField.name];
    if (known && !usedTargetFields.has(known.target)) {
      const targetField = targetSchema.fields.find(
        (f) => f.name === known.target
      );
      if (targetField) {
        mappings.push({
          sourceField: srcField.name,
          sourceLabel: srcField.label ?? srcField.name,
          targetField: known.target,
          targetLabel: targetField.label ?? known.target,
          transform: known.transform,
          confidence: 1.0,
          autoMapped: true,
        });
        usedTargetFields.add(known.target);
      }
    }
  }

  // Phase 2: Fuzzy-match remaining source fields to unmatched target fields
  const unmappedSourceFields = sourceFields.filter(
    (f) => !mappings.some((m) => m.sourceField === f.name)
  );
  const availableTargetFields = targetSchema.fields.filter(
    (f) => !usedTargetFields.has(f.name)
  );

  for (const srcField of unmappedSourceFields) {
    let bestMatch = null;
    let bestScore = 0;

    for (const tgtField of availableTargetFields) {
      if (usedTargetFields.has(tgtField.name)) continue;
      const score = Math.max(
        computeSimilarity(srcField.name, tgtField.name),
        computeSimilarity(srcField.label, tgtField.label)
      );
      if (score > bestScore && score >= 0.6) {
        bestScore = score;
        bestMatch = tgtField;
      }
    }

    if (bestMatch) {
      mappings.push({
        sourceField: srcField.name,
        sourceLabel: srcField.label ?? srcField.name,
        targetField: bestMatch.name,
        targetLabel: bestMatch.label ?? bestMatch.name,
        transform: 'direct',
        confidence: bestScore,
        autoMapped: true,
      });
      usedTargetFields.add(bestMatch.name);
    } else {
      mappings.push({
        sourceField: srcField.name,
        sourceLabel: srcField.label ?? srcField.name,
        targetField: null,
        targetLabel: null,
        transform: null,
        confidence: 0,
        autoMapped: false,
      });
    }
  }

  // Phase 3: Add required target fields that have no source mapped
  for (const tgtField of targetSchema.fields) {
    if (tgtField.required && !usedTargetFields.has(tgtField.name)) {
      mappings.push({
        sourceField: null,
        sourceLabel: null,
        targetField: tgtField.name,
        targetLabel: tgtField.label,
        transform: null,
        confidence: 0,
        autoMapped: false,
        unmappedRequired: true,
      });
    }
  }

  return mappings;
}

/**
 * Get the full target schema for an object type (for dropdowns).
 */
export function getTargetFields(objectType) {
  return FRESHSERVICE_SCHEMAS[objectType]?.fields ?? [];
}

/**
 * Get the ServiceNow table name for an object type.
 */
export function getSourceTable(objectType) {
  return SERVICENOW_TABLE_MAP[objectType] ?? null;
}
