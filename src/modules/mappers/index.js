import * as snToFs        from './servicenow-to-freshservice/incident.mapper.js';
import * as snToFsChange  from './servicenow-to-freshservice/change.mapper.js';
import * as snToFsProblem from './servicenow-to-freshservice/problem.mapper.js';
import * as snToFsUser    from './servicenow-to-freshservice/user.mapper.js';
import * as snToFsCompany from './servicenow-to-freshservice/company.mapper.js';
import * as snToFsKb      from './servicenow-to-freshservice/kb.mapper.js';

const MAPPER_REGISTRY = {
  'servicenow:freshservice': {
    incident: snToFs,
    change:   snToFsChange,
    problem:  snToFsProblem,
    user:     snToFsUser,
    company:  snToFsCompany,
    kb:       snToFsKb,
  },
  // 'jira:freshservice': { ... },
  // 'zendesk:freshservice': { ... },
};

export function getMappers(source, target) {
  const key = `${source}:${target}`;
  const mappers = MAPPER_REGISTRY[key];
  if (!mappers) throw new Error(`No mappers found for ${key}`);
  return mappers;
}
