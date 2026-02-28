export function mapRequester(snow, deptIdMap) {
  if (!snow.email) return null;
  const mapped = {
    first_name: snow.first_name || 'Unknown',
    last_name: snow.last_name || 'User',
    primary_email: snow.email || null,
    work_phone_number: snow.phone || null,
  };
  const deptId = deptIdMap?.get(snow.department?.value);
  if (deptId) mapped.department_id = deptId;
  return mapped;
}

export function mapAgent(snow) {
  return {
    first_name: snow.first_name || 'Unknown',
    last_name: snow.last_name || 'User',
    email: snow.email || null,
    roles: [{ role_id: 1, assignment_scope: 'entire_helpdesk' }], // default agent role
  };
}
