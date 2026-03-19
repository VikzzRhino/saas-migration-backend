// src/modules/field-mapping/value-transforms.js

import {
  resolveValueMapping,
  getMergedValueMappings,
} from './value-mapping-defaults.js';

// ── Static fallback maps (used when no custom value mappings configured) ─────

const PRIORITY_MAP = { 1: 4, 2: 3, 3: 2, 4: 1 };
const INCIDENT_STATUS_MAP = { 1: 2, 2: 2, 3: 3, 6: 4, 7: 5 };
const CHANGE_STATUS_MAP = {
  '-5': 1,
  '-4': 2,
  '-3': 3,
  '-2': 4,
  '-1': 4,
  0: 4,
  3: 5,
};
const CHANGE_TYPE_MAP = {
  standard: 2,
  normal: 2,
  emergency: 4,
  minor: 1,
  major: 3,
};
const PROBLEM_STATUS_MAP = { 1: 1, 2: 1, 3: 2, 4: 3 };
const IMPACT_MAP = { 1: 3, 2: 2, 3: 1 };
const RISK_MAP = { 1: 3, 2: 2, 3: 1, 4: 4 };
const KB_STATUS_MAP = { published: 2, draft: 1 };

function val(field) {
  if (field == null) return null;
  return typeof field === 'object'
    ? field?.display_value ?? field?.value
    : field;
}

function toISO(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const TRANSFORMS = {
  direct: (value) => val(value),
  priority_map: (value) => PRIORITY_MAP[Number(val(value))] ?? 2,
  incident_status_map: (value) => INCIDENT_STATUS_MAP[Number(val(value))] ?? 2,
  change_status_map: (value) => CHANGE_STATUS_MAP[String(val(value))] ?? 1,
  change_type_map: (value) => CHANGE_TYPE_MAP[val(value)?.toLowerCase()] ?? 2,
  problem_status_map: (value) => PROBLEM_STATUS_MAP[Number(val(value))] ?? 1,
  impact_map: (value) => IMPACT_MAP[Number(val(value))] ?? 2,
  risk_map: (value) => RISK_MAP[Number(val(value))] ?? 2,
  kb_status_map: (value) => KB_STATUS_MAP[val(value)] ?? 1,
  datetime: (value) => toISO(val(value)),
  admin_roles: () => [{ role_id: 1, assignment_scope: 'entire_helpdesk' }],
  resolve_requester: () => undefined,
  resolve_agent: () => undefined,
  resolve_group: () => undefined,
  resolve_department: () => undefined,
};

/**
 * Apply a single field mapping to extract and transform a value.
 */
export function applyTransform(sourceRecord, mapping) {
  if (!mapping.sourceField || !mapping.transform) return undefined;
  const rawValue = sourceRecord[mapping.sourceField];
  if (rawValue === undefined || rawValue === null) return undefined;

  const transformFn = TRANSFORMS[mapping.transform];
  if (!transformFn) return val(rawValue);
  return transformFn(rawValue);
}

/**
 * Apply all field mappings to a source record, returning a target object.
 * Handles custom_fields.* targets by writing into target.custom_fields sub-object.
 */
export function applyMappings(sourceRecord, fieldMappings) {
  const target = {};
  for (const mapping of fieldMappings) {
    if (!mapping.targetField || !mapping.sourceField) continue;
    const value = applyTransform(sourceRecord, mapping);
    if (value === undefined) continue;

    if (mapping.targetField.startsWith('custom_fields.')) {
      const customFieldName = mapping.targetField.replace('custom_fields.', '');
      if (!target.custom_fields) target.custom_fields = {};
      target.custom_fields[customFieldName] = value;
    } else {
      target[mapping.targetField] = value;
    }
  }
  return target;
}

/**
 * Apply configurable value mappings on top of a mapped record.
 * This takes the already-mapped target record and resolves enum/select fields
 * through the custom value mapping configuration.
 *
 * @param {object} sourceRecord - Raw ServiceNow record (for reading display values)
 * @param {object} targetRecord - Already field-mapped target record
 * @param {string} objectType - The object type (incidents, changes, etc.)
 * @param {object} customValueMappings - Custom value mappings from migration config (Map or object)
 * @param {object} context - Additional context (groupMapping, agentMatching, etc.)
 */
export function applyValueMappings(
  sourceRecord,
  targetRecord,
  objectType,
  customValueMappings = {},
  context = {}
) {
  const customObj =
    customValueMappings instanceof Map
      ? Object.fromEntries(customValueMappings)
      : customValueMappings ?? {};
  const merged = getMergedValueMappings(objectType, customObj);

  const result = { ...targetRecord };

  for (const [fieldName, fieldConfig] of Object.entries(merged)) {
    const sourceFieldMap = VALUE_FIELD_SOURCE_MAP[objectType]?.[fieldName];
    if (!sourceFieldMap) {
      if (fieldConfig.defaultValue != null && result[fieldName] === undefined) {
        result[fieldName] = fieldConfig.defaultValue;
      }
      continue;
    }

    const rawValue = sourceRecord[sourceFieldMap];
    if (rawValue === undefined) continue;

    const resolved = resolveValueMapping(fieldConfig, rawValue);
    if (resolved !== undefined) {
      result[fieldName] = resolved;
    }
  }

  // Resolve group_id from groupMapping context
  if (context.groupMapping?.length > 0) {
    const rawGroup = sourceRecord.assignment_group;
    const snGroupDisplay = val(rawGroup);
    const snGroupSysId =
      typeof rawGroup === 'object' ? rawGroup?.value : rawGroup;

    if (snGroupDisplay || snGroupSysId) {
      const groupEntry = context.groupMapping.find(
        (g) =>
          (snGroupSysId && g.snGroupId === snGroupSysId) ||
          (snGroupDisplay && g.snGroupName === snGroupDisplay)
      );
      if (groupEntry?.fsGroupId) {
        result.group_id = groupEntry.fsGroupId;
      } else {
        delete result.group_id;
      }
    }
  }

  // Resolve agent from agentMatching context
  if (context.agentMatching) {
    const rawAssigned = sourceRecord.assigned_to;
    const snAssignedDisplay = val(rawAssigned);
    const snAssignedSysId =
      typeof rawAssigned === 'object' ? rawAssigned?.value : rawAssigned;

    if (snAssignedDisplay || snAssignedSysId) {
      const agentEntry = context.agentMatching.entries?.find(
        (e) =>
          (snAssignedSysId && e.snSysId === snAssignedSysId) ||
          (snAssignedDisplay &&
            (e.snEmail === snAssignedDisplay || e.snName === snAssignedDisplay))
      );
      if (agentEntry?.fsAgentId) {
        result.responder_id = agentEntry.fsAgentId;
      } else if (context.agentMatching.defaultAgentId) {
        result.responder_id = context.agentMatching.defaultAgentId;
      } else {
        delete result.responder_id;
      }
    }
  }

  // Clean up null/undefined custom field values before POST
  if (result.custom_fields) {
    for (const [key, value] of Object.entries(result.custom_fields)) {
      if (value === null || value === undefined) {
        delete result.custom_fields[key];
      }
    }
  }

  return result;
}

/**
 * Maps: objectType.targetFieldName → sourceRecord field name
 * Used to find the source display_value for value mapping resolution.
 */
const VALUE_FIELD_SOURCE_MAP = {
  incidents: {
    status: 'state',
    priority: 'priority',
    urgency: 'urgency',
    impact: 'impact',
    source: 'contact_type',
    category: 'category',
  },
  changes: {
    status: 'state',
    change_type: 'type',
    priority: 'priority',
    impact: 'impact',
    risk: 'risk',
    category: 'category',
  },
  problems: {
    status: 'state',
    priority: 'priority',
    impact: 'impact',
    urgency: 'urgency',
    category: 'category',
  },
  kb_articles: {
    status: 'workflow_state',
  },
};
