import axios from 'axios';

export default class ServiceNowConnector {
  constructor({ instanceUrl, username, password }) {
    this.client = axios.create({
      baseURL: `${instanceUrl}/api/now`,
      auth: { username, password },
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
  }

  async fetchIncidents(limit = 10) {
    const res = await this.client.get('/table/incident', {
      params: { sysparm_limit: limit },
    });
    return res.data.result;
  }
}
