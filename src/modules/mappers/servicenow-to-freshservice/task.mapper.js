const TASK_STATUS_MAP = { 1: 1, 2: 2, 3: 3 }; // open→open, work_in_progress→in_progress, closed→completed

function val(field) {
  return typeof field === 'object' ? field?.display_value ?? field?.value : field;
}

function toISO(dateStr) {
  if (!dateStr) return null;
  const d = new Date(val(dateStr));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function mapTask(snow) {
  const mapped = {
    title: val(snow.short_description) || 'Task',
    description: val(snow.description) || val(snow.short_description) || '-',
    status: TASK_STATUS_MAP[Number(val(snow.state))] ?? 1,
  };

  const dueDate = toISO(snow.due_date);
  if (dueDate) mapped.due_date = dueDate;

  return mapped;
}
