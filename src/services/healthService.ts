export type HealthStatus = {
  status: 'ok';
  uptimeMs: number;
  timestamp: string;
};

export function getHealthStatus(now: Date = new Date()): HealthStatus {
  const uptimeMs = typeof process.uptime === 'function' ? process.uptime() * 1000 : 0;

  return {
    status: 'ok',
    uptimeMs: Math.max(0, Math.floor(uptimeMs)),
    timestamp: now.toISOString()
  };
}

