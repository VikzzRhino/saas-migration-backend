import ServiceNowConnector from './sources/servicenow.connector.js';
import FreshserviceConnector from './targets/freshservice.connector.js';

const SOURCE_CONNECTORS = {
  servicenow: ServiceNowConnector,
  // jira: JiraConnector,
};

const TARGET_CONNECTORS = {
  freshservice: FreshserviceConnector,
  // zendesk: ZendeskConnector,
};

export function createSourceConnector(system, credentials) {
  const Connector = SOURCE_CONNECTORS[system];
  if (!Connector) throw new Error(`Unsupported source system: ${system}`);
  return new Connector(credentials);
}

export function createTargetConnector(system, credentials) {
  const Connector = TARGET_CONNECTORS[system];
  if (!Connector) throw new Error(`Unsupported target system: ${system}`);
  return new Connector(credentials);
}
