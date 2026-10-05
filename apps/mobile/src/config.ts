import { LAMPORTS_PER_SOL } from '@flipthememe/client';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
/** Price reads go to mainnet (the PumpSwap pool); the list is tried in order with failover. */
export const MAINNET_RPCS = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'] as const;

export const CLUSTER = { id: 'solana:devnet', url: DEVNET_RPC } as const;
export const APP_IDENTITY = { name: 'FlipTheMeme', uri: 'https://flipthememe.com', icon: 'favicon.ico' };

export const FAUCET_URL = 'https://faucet.solana.com';
export const DEEP_LINK_PREFIX = 'flipthememe://round/';

export const POLL = {
  arenaMs: 2_000,
  accountMs: 4_000,
  priceMs: 1_500,
  clockMs: 60_000,
  /** Data older than this shows the offline / stale banner. */
  staleMs: 10_000,
} as const;

/** Mainnet price points kept for the chart. */
export const PRICE_HISTORY_MS = 10 * 60 * 1_000;

const sol = (hundredths: bigint) => (LAMPORTS_PER_SOL * hundredths) / 100n;

export const BET_AMOUNTS: readonly bigint[] = [sol(1n), sol(2n), sol(5n), sol(10n)];
export const TOP_UP_AMOUNTS: readonly bigint[] = [sol(10n), sol(25n), sol(50n)];
export const AIRDROP_LAMPORTS = LAMPORTS_PER_SOL;

export const SESSION_RULES = {
  /** Session lifetime granted by Top up & play. */
  durationSecs: 24 * 60 * 60,
  maxPerBet: sol(10n),
  /** The session key pays fees and the position rent (about 0.0016 SOL per bet). */
  gasTopUp: sol(3n),
  /** Top the key up only when it holds less than this. */
  gasMin: sol(1n),
  /** Below this the key cannot pay for one more position. */
  gasPerBet: 2_000_000n,
} as const;

/** Bets are refused this long before the program's cutoff, so a tap never races the close. */
export const ENTRY_GUARD_SECS = 1;
/** Manual claim shows up when the keeper has not claimed this long after the round is final. */
export const CLAIM_FALLBACK_SECS = 20;

const EXPLORER = 'https://explorer.solana.com';
export const explorer = {
  address: (a: string) => `${EXPLORER}/address/${a}?cluster=devnet`,
  tx: (signature: string) => `${EXPLORER}/tx/${signature}?cluster=devnet`,
  /** The price source lives on mainnet. */
  mainnetAddress: (a: string) => `${EXPLORER}/address/${a}`,
};

export const roundLink = (roundId: bigint) => `${DEEP_LINK_PREFIX}${roundId}`;
