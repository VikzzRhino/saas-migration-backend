import axios from 'axios';

export default class FreshserviceConnector {
  constructor({ domain, apiKey }) {
    this.client = axios.create({
      baseURL: `https://${domain}.freshservice.com/api/v2`,
      auth: { username: apiKey, password: 'X' },
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async createTicket({ subject, description }) {
    const res = await this.client.post('/tickets', {
      subject,
      description,
      email: 'migration@tool.com',
      priority: 1,
      status: 2,
    });
    return res.data.ticket;
  }
}
