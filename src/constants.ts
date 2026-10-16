// Papertrade deployment constants (HyperEVM mainnet, chain 999).
// Sources: docs.papertrade.xyz contract list + exchange frontend deployment config.

export const CHAIN_ID = 999;

export const ADDR = {
  exchange: '0x6cd5661646289fb6e65ea5c032310fded797d0a2',
  paperStaking: '0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016',
  paper: '0xe40f17915daa230324030003a197cdaef2261c0e',
  sessionKeyManager: '0x8326eb8896e358717f10502ec73ce8d28e37b108',
} as const;

export const URLS = {
  exchange: 'https://exchange.papertrade.xyz',
  stream: 'wss://stream.papertrade.xyz/connection/websocket',
  hlWs: 'wss://api.hyperliquid.xyz/ws',
  rpc: 'https://rpc.hyperliquid.xyz/evm',
} as const;

// Sent by the official frontend; harmless to mirror.
export const FRONTEND_BUILD = '53591f8c6c22';

export type Asset = 'BTC' | 'ETH';
export const ASSETS: Asset[] = ['BTC', 'ETH'];

export interface InstrumentParams {
  id: number;
  priceScale: number;
  baseRate: number;
  rateMultiplier: number;
  positionMultiplier: number;
  referenceNotional: number;
  bustBuffer: number;
  winFeeRate: number;
}

// Launch values; refreshed at runtime from /state/trading when available.
export const INSTRUMENTS: Record<Asset, InstrumentParams> = {
  BTC: {
    id: 0, priceScale: 10, baseRate: 0.1, rateMultiplier: 15000, positionMultiplier: 814.598,
    referenceNotional: 100_000, bustBuffer: 0.000476041580087574, winFeeRate: 0.02,
  },
  ETH: {
    id: 1, priceScale: 100, baseRate: 0.1, rateMultiplier: 15000, positionMultiplier: 483.979,
    referenceNotional: 100_000, bustBuffer: 0.00048130405018013, winFeeRate: 0.02,
  },
};

export const ASSET_BY_ID: Record<number, Asset> = { 0: 'BTC', 1: 'ETH' };

// EIP-712. The Exchange domain name really is the literal "String" (verified on-chain).
export const DOMAINS = {
  exchange: { name: 'String', version: '1', chainId: CHAIN_ID, verifyingContract: ADDR.exchange },
  paperStaking: { name: 'PaperStaking', version: '1', chainId: CHAIN_ID, verifyingContract: ADDR.paperStaking },
  cancellation: { name: 'PaperTrade Intent Cancel', version: '2', chainId: CHAIN_ID, verifyingContract: ADDR.exchange },
} as const;

export const TYPES = {
  RegisterSessionKey: [
    { name: 'user', type: 'address' }, { name: 'key', type: 'address' }, { name: 'expiry', type: 'uint64' },
    { name: 'feeAddress', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  OpenPosition: [
    { name: 'user', type: 'address' }, { name: 'instrumentId', type: 'uint32' }, { name: 'isLong', type: 'bool' },
    { name: 'size', type: 'uint128' }, { name: 'leverage', type: 'uint32' }, { name: 'useDebt', type: 'bool' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  Close: [
    { name: 'user', type: 'address' }, { name: 'positionIds', type: 'uint256[]' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  Stake: [
    { name: 'user', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  Claim: [
    { name: 'user', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  CancelIntent: [
    { name: 'user', type: 'address' }, { name: 'intentId', type: 'bytes32' }, { name: 'deadline', type: 'uint256' },
  ],
} as const;

export type IntentType = keyof typeof TYPES;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const SESSION_KEY_TTL_SEC = 30 * 24 * 3600;
export const INTENT_DEADLINE_SEC = 3600;
export const E18 = 10n ** 18n;
