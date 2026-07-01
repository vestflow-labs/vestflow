import { Router } from 'express';
import { getHealthStatus } from '../services/healthService';

const router = Router();

router.get('/health', (_req, res) => {
  res.status(200).json(getHealthStatus());
});

export default router;

