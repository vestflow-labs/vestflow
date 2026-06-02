import {
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc as StellarRpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

export interface ScheduleData {
  id: number;
  grantor: string;
  beneficiary: string;
  token: string;
  total_amount: bigint;
  claimed: bigint;
  start_time: number;
  duration: number;
  cliff_duration: number;
  kind: "Linear" | "Cliff" | "LinearWithCliff";
  revocable: boolean;
  revoked: boolean;
}

const NETWORK = process.env.NETWORK === "mainnet" ? "mainnet" : "testnet";
const NETWORK_PASSPHRASE = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const RPC_URL =
  process.env.RPC_URL ??
  (NETWORK === "mainnet"
    ? "https://mainnet.sorobanrpc.com"
    : "https://soroban-testnet.stellar.org");
const CONTRACT_ID =
  process.env.CONTRACT_ID ??
  "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX";
const FALLBACK_ACCOUNT =
  process.env.SIMULATION_SOURCE ??
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const server = new StellarRpc.Server(RPC_URL);

async function simulate(method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const contract = new Contract(CONTRACT_ID);
  const account = await server.getAccount(FALLBACK_ACCOUNT);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(result)) {
    throw new Error(result.error);
  }
  return result.result!.retval;
}

export async function getSchedule(id: number): Promise<ScheduleData | null> {
  try {
    const val = await simulate("get_schedule", [nativeToScVal(id, { type: "u64" })]);
    return parseSchedule(scValToNative(val));
  } catch {
    return null;
  }
}

export async function getClaimable(id: number): Promise<bigint> {
  try {
    const val = await simulate("claimable", [nativeToScVal(id, { type: "u64" })]);
    return BigInt(scValToNative(val));
  } catch {
    return 0n;
  }
}

function parseSchedule(raw: any): ScheduleData {
  return {
    id: Number(raw.id),
    grantor: raw.grantor?.toString() ?? "",
    beneficiary: raw.beneficiary?.toString() ?? "",
    token: raw.token?.toString() ?? "",
    total_amount: BigInt(raw.total_amount ?? 0),
    claimed: BigInt(raw.claimed ?? 0),
    start_time: Number(raw.start_time ?? 0),
    duration: Number(raw.duration ?? 0),
    cliff_duration: Number(raw.cliff_duration ?? 0),
    kind:
      raw.kind === "Cliff"
        ? "Cliff"
        : raw.kind === "LinearWithCliff"
          ? "LinearWithCliff"
          : "Linear",
    revocable: Boolean(raw.revocable),
    revoked: Boolean(raw.revoked),
  };
}
