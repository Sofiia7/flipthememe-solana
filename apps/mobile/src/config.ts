import { LAMPORTS_PER_SOL } from '@flipthememe/client';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
/** Devnet endpoints in failover order: a phone whose DNS loses one host still reaches the other. */
export const DEVNET_RPCS = [DEVNET_RPC, 'https://solana-devnet.api.onfinality.io/public'] as const;
/** Price reads go to mainnet (the PumpSwap pool); the list is tried in order with failover. */
export const MAINNET_RPCS = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'] as const;

export const CLUSTER = { id: 'solana:devnet', url: DEVNET_RPC } as const;
export const APP_IDENTITY = { name: 'FlipTheMeme', uri: 'https://sol.flipthememe.com', icon: 'icon-512.png' };

/** The public faucet: the fallback when the project's own test SOL faucet (FAUCET_API) cannot be reached. */
export const FAUCET_URL = 'https://faucet.solana.com';
/** The project's own devnet test SOL faucet (services/link): POST {"address"} for one drip per wallet. */
export const FAUCET_API = 'https://sol.flipthememe.com/v1/faucet';
/** The faucet is a quick call; a phone on a bad connection gives up after this and shows the fallback ways. */
export const FAUCET_TIMEOUT_MS = 12_000;
/** Live X chatter about the arena token (services/chatter, deployed as a Cloudflare Worker). */
export const CHATTER_URL = 'https://sol.flipthememe.com/v1/chatter';

export const POLL = {
  arenaMs: 2_000,
  /** Arena reads while another tab is open: config and rounds only, kept under the 10 s stale banner. */
  arenaHiddenMs: 8_000,
  /** Arena reads while no round is upcoming, open or in flight (the keeper creates each round 15 s ahead). */
  arenaQuietMs: 5_000,
  accountMs: 4_000,
  /** My account while none of my rounds is in play: only my own actions change it then, and they refresh at once. */
  accountIdleMs: 15_000,
  /** After my own action the account keeps the fast pace this long, in case the RPC is a moment behind. */
  accountAfterActionMs: 20_000,
  /** My positions (a getProgramAccounts) are read when my vault or session moves, and at least this often. */
  positionsMaxAgeMs: 120_000,
  /** A round the arena read this recently is taken from there instead of being read again for my account. */
  sharedRoundMs: 3_000,
  /** The round of a friend's challenge, outside the arena window: read again this often until it is final. */
  challengeRoundMs: 15_000,
  priceMs: 1_500,
  clockMs: 60_000,
  /** Data older than this shows the offline / stale banner. */
  staleMs: 10_000,
} as const;

/** After HTTP 429 an RPC endpoint is left alone 2 s, doubling on each repeat up to 30 s (longer if Retry-After asks). */
export const RPC_COOL_DOWN = { baseMs: 2_000, maxMs: 30_000 } as const;

/** Mainnet price points kept for the chart. */
export const PRICE_HISTORY_MS = 10 * 60 * 1_000;

const sol = (hundredths: bigint) => (LAMPORTS_PER_SOL * hundredths) / 100n;

export const BET_AMOUNTS: readonly bigint[] = [sol(1n), sol(2n), sol(5n), sol(10n)];
export const TOP_UP_AMOUNTS: readonly bigint[] = [sol(10n), sol(25n), sol(50n)];
export const AIRDROP_LAMPORTS = LAMPORTS_PER_SOL;
/** The program's usual minimum stake, used only until the config account has been read. */
export const DEFAULT_MIN_STAKE = sol(1n);

export const SESSION_RULES = {
  /**
   * Session lifetime granted by Top up & play: 7 days, the program's maximum, less 10 minutes so a
   * phone clock a little ahead of the chain never asks for more than the program allows.
   */
  durationSecs: 7 * 24 * 60 * 60 - 10 * 60,
  maxPerBet: sol(10n),
  /**
   * The session's allowance (start_session's session_cap) is this many times what the account holds.
   * The program counts every stake in `spent` and never gives it back, so the cap limits turnover,
   * not loss: bets come out of the vault's available balance, and a stolen device key can neither
   * withdraw nor bet more than max-per-bet per round. A cap equal to the deposit used up one-tap play
   * after 5 bets on a 0.10 top up while the money was still there. See sessionCapFor (wallet/topUpPlan.ts).
   */
  capTurnoverFactor: 100n,
  /**
   * SOL sent to the device key, which pays only the network fee of each bet (5000 lamports): the
   * position rent comes from the game balance. 0.005 SOL lasts about 800 bets.
   */
  gasTopUp: 5_000_000n,
  /** Top the key up only when it holds less than this. */
  gasMin: 2_000_000n,
  /** Below this the key cannot pay one more fee and keep its own rent-exempt minimum. */
  gasPerBet: 1_000_000n,
} as const;

/**
 * A claim the device key pays itself costs the same network fee as a bet and must leave the key above its own
 * rent-exempt minimum, so the key needs what one more bet needs (SESSION_RULES.gasPerBet). Below it the claim
 * goes through the wallet instead. (This was a loose 20_000 lamports, far under the rent-exempt minimum.)
 */
export const CLAIM_KEY_MIN_LAMPORTS = SESSION_RULES.gasPerBet;

/** A "did your call win?" reminder fires this long after the exit window of the round ends (the keeper settles within seconds). */
export const RESULT_REMINDER_DELAY_SECS = 15;

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
  /** Where traders look at a token: its PumpSwap pair on DexScreener. */
  dexscreener: (pool: string) => `https://dexscreener.com/solana/${pool}`,
};
