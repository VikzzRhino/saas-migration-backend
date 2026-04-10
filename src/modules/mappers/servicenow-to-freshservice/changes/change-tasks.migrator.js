import { throttledPost } from '../../../../utils/throttled-request.js';

export const TASK_STATUS_MAP = {
  Open: 1,
  'Work In Progress': 2,
  'Closed Complete': 3,
  'Closed Incomplete': 3,
  Cancelled: 3,
};

function displayVal(field) {
  if (!field) return '';
  return typeof field === 'object'
    ? field.display_value ?? field.value ?? ''
    : field;
}

function toISO(field) {
  if (!field) return null;
  const raw =
    typeof field === 'object' ? field.display_value ?? field.value : field;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Migrates all tasks from a ServiceNow change to a Freshservice change.
 *
 * @param {string} snowChangeId - ServiceNow change sys_id
 * @param {number} freshChangeId - Freshservice change ID
 * @param {object} context
 * @param {object} context.snowClient - ServiceNow HTTP client with get(url, params) method
 * @param {object} context.fsClient - Freshservice HTTP client with post(path, body) method
 * @param {Map<string, number>} context.agentEmailToId - Snow agent display name → FS agent ID
 * @param {Map<string, number>} context.groupNameToId - Snow group display name → FS group ID
 * @param {string} context.snowBaseUrl - ServiceNow base URL e.g. https://instance.service-now.com
 * @param {object} context.logger - Logger with info(), warn(), error() methods
 * @returns {Promise<{ total: number, migrated: number, failed: number, skipped: number }>}
 */
export async function migrateChangeTasks(snowChangeId, freshChangeId, context) {
  const {
    snowClient,
    fsClient,
    agentEmailToId,
    groupNameToId,
    snowBaseUrl,
    logger,
  } = context;

  const summary = { total: 0, migrated: 0, failed: 0, skipped: 0 };

  // Step 1 — Fetch tasks from ServiceNow change_task table
  let tasks = [];
  try {
    const response = await snowClient.get(
      `${snowBaseUrl}/api/now/table/change_task`,
      {
        sysparm_query: `change_request=${snowChangeId}`,
        sysparm_fields:
          'sys_id,short_description,description,state,priority,assigned_to,assignment_group,due_date,opened_at',
        sysparm_display_value: 'all',
        sysparm_limit: 100,
      }
    );
    tasks = response?.result ?? [];
  } catch (err) {
    logger.error(
      `[change-tasks] Failed to fetch tasks for SN change ${snowChangeId}: ${err.message}`
    );
    return summary;
  }

  summary.total = tasks.length;

  // Steps 2 & 3 — Build payload and post sequentially
  for (const task of tasks) {
    const snowSysId =
      typeof task.sys_id === 'object'
        ? task.sys_id?.value ?? task.sys_id?.display_value
        : task.sys_id;

    const rawTitle = displayVal(task.short_description);

    // Skip if short_description is empty
    if (!rawTitle || !rawTitle.trim()) {
      summary.skipped++;
      continue;
    }

    const rawDescription = displayVal(task.description);
    const footer = `Migrated from ServiceNow change_task ${snowSysId}`;
    const description =
      rawDescription && rawDescription.trim()
        ? `${rawDescription.trim()}\n${footer}`
        : footer;

    const stateDisplay = displayVal(task.state);
    const status = TASK_STATUS_MAP[stateDisplay] ?? 1;

    const payload = {
      title: rawTitle.trim() || 'Migrated Task',
      status,
      notify_before: 0,
      description,
    };

    const dueDate = toISO(task.due_date);
    if (dueDate && new Date(dueDate) > new Date()) {
      payload.due_date = dueDate;
    }

    // Resolve agent_id
    const assignedToDisplay = displayVal(task.assigned_to);
    if (assignedToDisplay && agentEmailToId) {
      const agentId = agentEmailToId.get(assignedToDisplay);
      if (agentId !== undefined) payload.agent_id = agentId;
    }

    // Resolve group_id
    const groupDisplay = displayVal(task.assignment_group);
    if (groupDisplay && groupNameToId) {
      const groupId = groupNameToId.get(groupDisplay);
      if (groupId !== undefined) payload.group_id = groupId;
    }

    // Step 3 — POST to Freshservice
    try {
      const result = await throttledPost(
        fsClient,
        `/api/v2/changes/${freshChangeId}/tasks`,
        payload,
        { tag: 'change-tasks' }
      );
      const freshTaskId = result?.task?.id ?? result?.id ?? 'unknown';
      logger.info(
        `[change-tasks] Migrated task snow_sys_id=${snowSysId} → fresh_task_id=${freshTaskId}`
      );
      summary.migrated++;
    } catch (err) {
      const fsError = err?.response?.data;
      logger.error(
        `[change-tasks] Failed to post task snow_sys_id=${snowSysId}: ${
          err.message
        }${fsError ? ' | FS response: ' + JSON.stringify(fsError) : ''}`
      );
      summary.failed++;
    }
  }

  return summary;
}
