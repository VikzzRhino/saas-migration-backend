import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import tenantRoutes from './modules/tenants/tenant.routes.js';
import migrationRoutes from './modules/migration/migration.routes.js';
import logsRoutes from './modules/logs/logs.routes.js';
import connectionsRoutes from './modules/connections/connections.routes.js';
import reportsRoutes from './modules/reports/reports.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

app.get('/', (req, res) =>
  res.json({
    status: 'ok',
    message: 'API is running and SaaS migration backend is all set and ready.',
  })
);
app.get('/health', (req, res) =>
  res.json({
    status: 'ok',
    message: 'API is running and SaaS migration backend is all set and ready.',
  })
);
app.use('/api/auth', authRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/migrations', migrationRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/connections', connectionsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/admin', adminRoutes);

export default app;
