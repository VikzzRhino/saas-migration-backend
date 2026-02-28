import mongoose from 'mongoose';

class MongoService {
  constructor() {
    this.connection = null;
    this.isConnected = false;
  }

  async connect() {
    if (this.isConnected) {
      console.log('MongoDB already connected');
      return this.connection;
    }

    const mongoUri =
      process.env.MONGO_URI || 'mongodb://localhost:27017/saas-migration';

    this.connection = await mongoose.connect(mongoUri, {
      minPoolSize: 10,
      maxPoolSize: 1000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 30000,
      family: 4,
    });
    this.isConnected = true;
    console.log('✅ MongoDB connected');

    mongoose.connection.on('error', (err) => {
      console.error('MongoDB error:', err);
      this.isConnected = false;
    });
    mongoose.connection.on('disconnected', () => {
      console.log('MongoDB disconnected');
      this.isConnected = false;
    });
    mongoose.connection.on('reconnected', () => {
      console.log('MongoDB reconnected');
      this.isConnected = true;
    });

    process.on('SIGINT', async () => {
      await this.disconnect();
      process.exit(0);
    });

    return this.connection;
  }

  async disconnect() {
    if (this.connection && this.isConnected) {
      await mongoose.disconnect();
      this.isConnected = false;
      console.log('MongoDB disconnected successfully');
    }
  }

  isConnectionReady() {
    return this.isConnected && mongoose.connection.readyState === 1;
  }
}

export default new MongoService();
