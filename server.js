import './load-env.js';
import express from 'express';
import cors from 'cors';
import { initDatabase } from './db.js';
import { expensesRouter } from './routes/expenses.js';
import { budgetRouter } from './routes/budget.js';
import { aiRouter } from './routes/ai.js';
import { newsRouter } from './routes/news.js';
import { cloudRouter } from './routes/cloud.js';
import { syncRouter } from './routes/sync.js';
import { startNewsSyncScheduler } from './news_feed_service.js';

const PORT = Number(process.env.PORT) || 3000;

initDatabase();
startNewsSyncScheduler();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/v1/expenses', expensesRouter);
app.use('/api/v1/budget', budgetRouter);
app.use('/api/v1/ai', aiRouter);
app.use('/api/v1/news', newsRouter);
app.use('/api/v1/cloud', cloudRouter);
app.use('/api/v1/sync', syncRouter);

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

app.listen(PORT, () => {
  console.log(`Nexus AI API listening on http://localhost:${PORT}`);
});
