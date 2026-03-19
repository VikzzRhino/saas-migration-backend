export function mapDepartment(snow) {
  const mapped = {
    name: snow.name,
    description: snow.notes || null,
  };

  if (snow.website) {
    const raw = String(snow.website).trim();
    const domain = raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .trim();
    if (domain && /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
      mapped.domains = [domain];
    }
  }

  return mapped;
}
