export function mapDepartment(snow) {
  return {
    name: snow.name,
    description: snow.notes || null,
  };
}
