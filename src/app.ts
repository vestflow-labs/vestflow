import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import healthRouter from './routes/health';
import { errorHandler } from './middleware/errorHandler';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', healthRouter);

app.use(errorHandler);

const port = process.env.PORT ? Number(process.env.PORT) : 5000;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Express API listening on port ${port}`);
});

export default app;

