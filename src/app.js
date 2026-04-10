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
app.use(
  cors({
    origin: true, // reflect request origin (works as "allow all" with credentials)
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
    ],
  })
);
app.use((req, res, next) => {
  // Extra safeguard for proxies/load balancers that can interfere with preflight headers.
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  res.header(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  );
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
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
