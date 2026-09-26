export type NetworkName = "mainnet" | "testnet";

export interface NetworkConfig {
  network: NetworkName;
  rpcUrl: string;
  contractId: string;
}

export interface DatabasePoolConfig {
  min: number;
  max: number;
  idleTimeoutMs: number;
}

export const DATABASE_POOL_DEFAULTS: Readonly<DatabasePoolConfig> = {
  min: 0,
  max: 20,
  idleTimeoutMs: 30000,
};

const MAX_SAFE_POOL_VALUE = Number.MAX_SAFE_INTEGER;
const MAX_IDLE_TIMEOUT_MS = 2_147_483_647;

function parseDatabasePoolValue(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `Invalid ${name}: expected an integer between ${minimum} and ${maximum}, received ${JSON.stringify(value)}`,
    );
  }
  const parsed = Number(normalized);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `Invalid ${name}: expected an integer between ${minimum} and ${maximum}, received ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

export function getDatabasePoolConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DatabasePoolConfig {
  const min = parseDatabasePoolValue(
    "DB_POOL_MIN",
    env.DB_POOL_MIN,
    DATABASE_POOL_DEFAULTS.min,
    0,
    MAX_SAFE_POOL_VALUE,
  );
  const max = parseDatabasePoolValue(
    "DB_POOL_MAX",
    env.DB_POOL_MAX,
    DATABASE_POOL_DEFAULTS.max,
    1,
    MAX_SAFE_POOL_VALUE,
  );
  const idleTimeoutMs = parseDatabasePoolValue(
    "DB_IDLE_TIMEOUT_MS",
    env.DB_IDLE_TIMEOUT_MS,
    DATABASE_POOL_DEFAULTS.idleTimeoutMs,
    0,
    MAX_IDLE_TIMEOUT_MS,
  );

  if (min > max) {
    throw new Error(
      `Invalid database pool configuration: DB_POOL_MIN (${min}) cannot exceed DB_POOL_MAX (${max})`,
    );
  }

  return { min, max, idleTimeoutMs };
}

const DEFAULT_CONTRACT_IDS: Record<NetworkName, string> = {
  testnet: "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX",
  mainnet: "",
};

const DEFAULT_RPC_URLS: Record<NetworkName, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
};

export function parseNetwork(value: string | null | undefined): NetworkName {
  if (value == null || value === "") return "testnet";
  if (value === "mainnet" || value === "testnet") return value;
  throw new Error(`Unsupported network: ${value}`);
}

export function getNetworkConfig(network = parseNetwork(process.env.INDEXER_NETWORK)): NetworkConfig {
  const upper = network.toUpperCase();
  return {
    network,
    rpcUrl:
      process.env[`RPC_URL_${upper}`] ??
      process.env.RPC_URL ??
      DEFAULT_RPC_URLS[network],
    contractId:
      process.env[`CONTRACT_ID_${upper}`] ??
      process.env.CONTRACT_ID ??
      DEFAULT_CONTRACT_IDS[network],
  };
}
