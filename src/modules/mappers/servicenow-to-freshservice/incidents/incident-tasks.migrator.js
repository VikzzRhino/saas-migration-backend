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
 * Migrates all tasks from a ServiceNow incident to a Freshservice ticket.
 *
 * @param {string} snowIncidentId - ServiceNow incident sys_id
 * @param {number} freshTicketId - Freshservice ticket ID
 * @param {object} context
 * @param {object} context.snowClient - ServiceNow HTTP client with get(url, params) → { result: [] }
 * @param {object} context.fsClient - Freshservice HTTP client with post(path, body) → response
 * @param {Map<string, number>} context.agentEmailToId - SN agent display name/email → FS agent ID
 * @param {Map<string, number>} context.groupNameToId - SN group display name → FS group ID
 * @param {string} context.snowBaseUrl - ServiceNow base URL e.g. https://instance.service-now.com
 * @param {object} context.logger - Logger with info(), error() methods
 * @returns {Promise<{ total: number, migrated: number, failed: number, skipped: number }>}
 */
export async function migrateIncidentTasks(
  snowIncidentId,
  freshTicketId,
  context
) {
  const {
    snowClient,
    fsClient,
    agentEmailToId,
    groupNameToId,
    snowBaseUrl,
    logger,
  } = context;

  const summary = { total: 0, migrated: 0, failed: 0, skipped: 0 };

  // Step 1 — Fetch incident tasks from ServiceNow task table
  let tasks = [];
  try {
    const response = await snowClient.get(`${snowBaseUrl}/api/now/table/task`, {
      sysparm_query: `parent=${snowIncidentId}^sys_class_name=incident_task`,
      sysparm_fields:
        'sys_id,short_description,description,state,priority,assigned_to,assignment_group,due_date,opened_at',
      sysparm_display_value: 'all',
      sysparm_limit: 100,
    });
    tasks = response?.result ?? [];
  } catch (err) {
    logger.error(
      `[incident-tasks] Failed to fetch tasks for SN incident ${snowIncidentId}: ${err.message}`
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

    // a) Skip if short_description is empty
    if (!rawTitle || !rawTitle.trim()) {
      summary.skipped++;
      continue;
    }

    // c) Build description with footer
    const rawDescription = displayVal(task.description);
    const footer = `Migrated from ServiceNow incident_task ${snowSysId}`;
    const description =
      rawDescription && rawDescription.trim()
        ? `${rawDescription.trim()}\n${footer}`
        : footer;

    // d) Map status
    const stateDisplay = displayVal(task.state);
    const status = TASK_STATUS_MAP[stateDisplay] ?? 1;

    const payload = {
      task: {
        title: rawTitle.trim() || 'Migrated Task',
        description,
        status,
        notify_before: 0,
      },
    };

    // e) due_date — only set if resolved
    const dueDate = toISO(task.due_date);
    if (dueDate) payload.task.due_date = dueDate;

    // f) agent_id — omit if not resolved
    const assignedToDisplay = displayVal(task.assigned_to);
    if (assignedToDisplay && agentEmailToId) {
      const agentId = agentEmailToId.get(assignedToDisplay);
      if (agentId !== undefined) payload.task.agent_id = agentId;
    }

    // g) group_id — omit if not resolved
    const groupDisplay = displayVal(task.assignment_group);
    if (groupDisplay && groupNameToId) {
      const groupId = groupNameToId.get(groupDisplay);
      if (groupId !== undefined) payload.task.group_id = groupId;
    }

    // Step 3 — POST to Freshservice
    try {
      const result = await throttledPost(
        fsClient,
        `/api/v2/tickets/${freshTicketId}/tasks`,
        payload,
        { tag: 'incident-tasks' }
      );
      const freshTaskId = result?.task?.id ?? result?.id ?? 'unknown';
      logger.info(
        `[incident-tasks] Migrated task snow_sys_id=${snowSysId} → fresh_task_id=${freshTaskId}`
      );
      summary.migrated++;
    } catch (err) {
      logger.error(
        `[incident-tasks] Failed to post task snow_sys_id=${snowSysId}: ${err.message}`
      );
      summary.failed++;
    }
  }

  // Step 4 — Return summary
  return summary;
}
