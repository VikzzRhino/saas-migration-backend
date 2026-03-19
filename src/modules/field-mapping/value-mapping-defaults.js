/**
 * Default value mappings for ServiceNow → Freshservice migration.
 *
 * Structure per object:
 *   fieldName: {
 *     defaultValue: <fallback when source value is empty or unmapped>,
 *     map: { <source display_value> : <target API value> }
 *   }
 *
 * These are the starting point; users can override them per migration.
 */

// ─── Incidents → Tickets ───────────────────────────────────────────────────────

const INCIDENT_VALUE_MAPPINGS = {
  status: {
    defaultValue: 2, // Open
    map: {
      New: 2,
      'In Progress': 2,
      'On Hold': 3,
      Canceled: 2,
      Resolved: 4,
      Closed: 5,
    },
  },
  priority: {
    defaultValue: 1, // Low
    map: {
      '1 - Critical': 4,
      '2 - High': 3,
      '3 - Moderate': 2,
      '4 - Low': 1,
      '5 - Planning': 1,
    },
  },
  urgency: {
    defaultValue: null,
    map: {
      '1 - High': 3,
      '2 - Medium': 2,
      '3 - Low': 1,
    },
  },
  impact: {
    defaultValue: null,
    map: {
      '1 - High': 3,
      '2 - Medium': 2,
      '3 - Low': 1,
    },
  },
  source: {
    defaultValue: 3, // Phone
    map: {
      Email: 1,
      'Self-service': 2,
      Phone: 3,
      Chat: 4,
      'Virtual Agent': 2,
      'Walk-in': 9,
      Monitoring: 10,
    },
  },
  type: {
    defaultValue: 'Incident',
    map: {},
  },
  category: {
    defaultValue: null,
    map: {
      Network: 'Network',
      Software: 'Software',
      Hardware: 'Hardware',
      'Password Reset': null,
      'Inquiry / Help': null,
      Database: null,
    },
  },
};

// ─── Changes ───────────────────────────────────────────────────────────────────

const CHANGE_VALUE_MAPPINGS = {
  status: {
    defaultValue: 1, // Open
    map: {
      New: 1,
      Open: 1,
      'Work in Progress': 1,
      Assess: 1,
      Authorize: 1,
      Scheduled: 1,
      Implement: 1,
      Review: 1,
      Closed: 5,
      'Closed Incomplete': 1,
      'Closed Skipped': 1,
    },
  },
  change_type: {
    defaultValue: 1, // Minor
    map: {
      Emergency: 4,
      Standard: 2,
      Normal: 1,
      Model: 1,
    },
  },
  priority: {
    defaultValue: 1, // Low
    map: {
      '1 - Critical': 4,
      '2 - High': 3,
      '3 - Moderate': 2,
      '4 - Low': 1,
      '5 - Planning': 1,
    },
  },
  impact: {
    defaultValue: 1, // Low
    map: {
      '1 - High': 3,
      '2 - Medium': 2,
      '3 - Low': 1,
    },
  },
  risk: {
    defaultValue: 1, // Low
    map: {
      Low: 1,
      None: 1,
      Moderate: 1,
      High: 3,
      'Very High': 4,
    },
  },
  category: {
    defaultValue: null,
    map: {
      Software: 'Software',
      Network: 'Network',
      Hardware: 'Hardware',
      Other: 'Other',
      Service: null,
      Telecom: null,
      'System Software': null,
      Documentation: null,
      'ServiceNow Deployment': null,
      'Applications Software': null,
    },
  },
  // Change task status mappings
  task_status: {
    defaultValue: 1, // Open
    map: {
      Open: 1,
      'Work in Progress': 1,
      Pending: 1,
      'Closed Complete': 5,
      'Closed Incomplete': 1,
      'Closed Skipped': 1,
    },
  },
};

// ─── Problems ──────────────────────────────────────────────────────────────────

const PROBLEM_VALUE_MAPPINGS = {
  status: {
    defaultValue: 1, // Open
    map: {
      New: 1,
      Open: 1,
      'Work in Progress': 1,
      Assess: 1,
      'Root Cause Analysis': 1,
      'Fix in Progress': 1,
      Pending: 1,
      Resolved: 1,
      Closed: 3,
      'Closed Complete': 3,
      'Closed Incomplete': 1,
      'Closed Skipped': 1,
    },
  },
  urgency: {
    defaultValue: null,
    map: {
      '1 - High': 3,
      '2 - Medium': 2,
      '3 - Low': 1,
    },
  },
  priority: {
    defaultValue: 1, // Low
    map: {
      '1 - Critical': 4,
      '2 - High': 3,
      '3 - Moderate': 2,
      '4 - Low': 1,
      '5 - Planning': 1,
    },
  },
  impact: {
    defaultValue: 1, // Low
    map: {
      '1 - High': 3,
      '2 - Medium': 2,
      '3 - Low': 1,
    },
  },
  category: {
    defaultValue: null,
    map: {
      Hardware: 'Hardware',
      Network: 'Network',
      Software: 'Software',
      Database: null,
    },
  },
  // Problem task status mappings
  task_status: {
    defaultValue: 1, // Open
    map: {
      New: 1,
      Open: 1,
      'Work in Progress': 1,
      Pending: 1,
      'Closed Complete': 5,
      'Closed Incomplete': 1,
      'Closed Skipped': 1,
      Assess: 1,
      Closed: 1,
    },
  },
};

// ─── KB Articles ───────────────────────────────────────────────────────────────

const KB_ARTICLE_VALUE_MAPPINGS = {
  status: {
    defaultValue: 1, // Draft
    map: {
      Draft: 1,
      Review: 1,
      Outdated: 1,
      'Scheduled for publish': 1,
      Published: 2,
      Retired: 1,
      'Pending retirement': 1,
    },
  },
};

// ─── Assignment Group Defaults (all map to "Unassigned" i.e. null) ─────────────

const GROUP_MAPPING_DEFAULT = {
  defaultValue: null,
  map: {},
};

// ─── All Defaults ──────────────────────────────────────────────────────────────

export const DEFAULT_VALUE_MAPPINGS = {
  incidents: INCIDENT_VALUE_MAPPINGS,
  changes: CHANGE_VALUE_MAPPINGS,
  problems: PROBLEM_VALUE_MAPPINGS,
  kb_articles: KB_ARTICLE_VALUE_MAPPINGS,
  users: {},
  admins: {},
  companies: {},
};

/**
 * Resolve a value through a value mapping config.
 * @param {object} fieldConfig - { defaultValue, map }
 * @param {*} sourceValue - The raw source display value
 * @returns {*} The mapped target value
 */
export function resolveValueMapping(fieldConfig, sourceValue) {
  if (!fieldConfig || !fieldConfig.map) return sourceValue;

  const displayVal =
    typeof sourceValue === 'object'
      ? sourceValue?.display_value ?? sourceValue?.value
      : sourceValue;

  if (displayVal == null || displayVal === '') {
    return fieldConfig.defaultValue ?? null;
  }

  const key = String(displayVal);
  if (key in fieldConfig.map) {
    return fieldConfig.map[key];
  }

  const numKey = Number(displayVal);
  if (!isNaN(numKey)) {
    const numStr = String(numKey);
    if (numStr in fieldConfig.map) return fieldConfig.map[numStr];
  }

  return fieldConfig.defaultValue ?? null;
}

/**
 * Get default value mappings for an object type, merging with any custom overrides.
 */
export function getMergedValueMappings(objectType, customMappings = {}) {
  const defaults = DEFAULT_VALUE_MAPPINGS[objectType] ?? {};
  const merged = { ...defaults };

  for (const [field, config] of Object.entries(customMappings)) {
    if (merged[field]) {
      merged[field] = {
        defaultValue: config.defaultValue ?? merged[field].defaultValue,
        map: { ...merged[field].map, ...config.map },
      };
    } else {
      merged[field] = config;
    }
  }

  return merged;
}
