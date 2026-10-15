import type { Asset } from '../constants.ts';

export interface Position {
  id: string;
  asset: Asset;
  isLong: boolean;
  entry: number;      // USD
  margin: number;     // USD
  leverage: number;
  bust: number;       // USD
  openedAt: number;   // ms
}

export interface CloseResult {
  positionId: string;
  netPnl: number;      // USD credited/debited vs. margin (after haircut + fee)
  liquidated: boolean;
  paperMinted: number;
  exit?: number;
}

export interface Executor {
  readonly mode: 'sim' | 'live';
  init(): Promise<void>;
  /**
   * Opens a position and resolves once it is filled. Aborting the signal cancels the request;
   * if it fills anyway after that, the executor closes it itself.
   */
  open(asset: Asset, isLong: boolean, margin: number, leverage: number, signal?: AbortSignal): Promise<Position>;
  /** Closes a position and resolves with the settled result (also resolves if it was liquidated first). */
  close(pos: Position): Promise<CloseResult>;
  /**
   * Closes several positions in ONE request so they settle together at the same price.
   * Resolves per position; a position that could not be included rejects individually.
   */
  closeMany(positions: Position[]): Promise<PromiseSettledResult<CloseResult>[]>;
  /** Fires when one of our positions settles without a close() from us (liquidation, or closed elsewhere). */
  onSettled(cb: (r: CloseResult) => void): void;
  /** Free USD balance available for new margin. */
  freeBalance(): number;
  /** Ids of positions this executor currently believes are open and ours. */
  openPositionIds(): string[];
  /** Account-lifetime realised PnL in USD (live: from the exchange), or undefined if unknown. */
  lifetimePnl(): number | undefined;
  /** Stake any unstaked PAPER (no-op if below the protocol minimum). */
  stakePaper(): Promise<void>;
  claimRewards(): Promise<void>;
  paperSummary(): { unstaked: number; staked: number; mintedSession: number };
  shutdown(): Promise<void>;
}
