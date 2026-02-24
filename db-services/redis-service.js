import Redis from 'ioredis';

class RedisService {
  constructor() {
    const config = {
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      retryDelayOnFailover: 100,
      lazyConnect: true,
      retryStrategy: () => null,
    };

    const bullConfig = {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryDelayOnFailover: 100,
      lazyConnect: true,
      retryStrategy: () => null,
    };

    this.client = new Redis(process.env.REDIS_URL, config);
    this.subscriber = new Redis(process.env.REDIS_URL, config);
    this.publisher = this.client;
    this.bullWorkerClient = new Redis(process.env.REDIS_URL, bullConfig);
    this.channels = new Map();

    this._attachEvents(this.client, 'Main Redis');
    this._attachEvents(this.subscriber, 'Subscriber Redis');
    this._attachEvents(this.bullWorkerClient, 'Bull Redis');
  }

  _attachEvents(client, name) {
    client.on('error', (err) => console.error(`${name} error:`, err));
    client.on('connect', () => console.log(`✅ ${name} connected`));
    client.on('ready', () => console.log(`${name} ready`));
    client.on('close', () => console.log(`${name} closed`));
  }

  async connect() {
    if (this.client.status === 'ready' || this.client.status === 'connecting') return;
    await this.client.connect();
    await this.subscriber.connect();
    console.log('✅ Redis connections established');
  }

  async connectBullWorker() {
    if (this.bullWorkerClient.status === 'ready' || this.bullWorkerClient.status === 'connecting') return;
    await this.bullWorkerClient.connect();
    console.log('✅ Bull Redis worker connected');
  }

  async disconnect() {
    await this.client.quit();
    await this.subscriber.quit();
  }

  async disconnectBullWorker() {
    await this.bullWorkerClient.quit();
  }

  async publish(channel, data) {
    await this.publisher.publish(channel, JSON.stringify(data));
  }

  getClient() { return this.client; }
  getSubscriber() { return this.subscriber; }
  getPublisher() { return this.publisher; }
  getBullWorkerClient() { return this.bullWorkerClient; }
  getChannels() { return this.channels; }
}

export default new RedisService();
