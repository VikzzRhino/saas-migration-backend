import ServiceNowConnector from './servicenow.connector.js';
import FreshserviceConnector from './freshservice.connector.js';

export function createConnector(system, credentials) {
  switch (system) {
    case 'servicenow':
      return new ServiceNowConnector(credentials);
    case 'freshservice':
      return new FreshserviceConnector(credentials);
    default:
      throw new Error(`Unsupported system: ${system}`);
  }
}
