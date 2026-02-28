import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import tenantRoutes from './modules/tenants/tenant.routes.js';
import migrationRoutes from './modules/migration/migration.routes.js';

const app = express();

app.use(helmet());
// API-only backend: all state-changing routes require x-api-key header (see apiKey.middleware.js)
// Custom header requirement makes CSRF attacks impossible from browsers
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') ?? false }));
app.use(morgan('dev'));
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/tenants', tenantRoutes);
app.use('/api/migrations', migrationRoutes);

export default app;
