import { lido, yieldTokens as lidoTokens } from './tokens/lido';
import {
  rocketpool,
  yieldTokens as rocketpoolTokens,
} from './tokens/rocketpool';
import {
  lidoPolygon,
  yieldTokens as lidoPolygonTokens,
} from './tokens/lido-polygon';
import { aave, allYieldTokens as aaveTokens } from './tokens/aave';
import { overnight, yieldTokens as overnightTokens } from './tokens/overnight';
import { sfrxETH, yieldTokens as fraxTokens } from './tokens/sfrxeth';
import { maticX, yieldTokens as staderLabsTokens } from './tokens/maticx';
import { tranchess, yieldTokens as tranchessTokens } from './tokens/tranchess';
import { usdr, yieldTokens as usdrTokens } from './tokens/usdr';
import { stafi, yieldTokens as stafiTokens } from './tokens/stafi';
import { tessera, yieldTokens as tesseraTokens } from './tokens/tessera';
// import { euler, yieldTokens as eulerTokens } from './tokens/euler';
import { idleDai, yieldTokens as idleDaiToken } from './tokens/idle-dai';
import { idleUsdt, yieldTokens as idleUsdtToken } from './tokens/idle-usdt';
import { idleUsdc, yieldTokens as idleUsdcToken } from './tokens/idle-usdc';
import { gearbox, yieldTokens as gearboxTokens } from './tokens/gearbox';
import { reaper, yieldTokens as reaperTokens } from './tokens/reaper';
import { Network, Findable } from '@/types';

/**
 * Common interface for fetching APR from external sources
 * @interal
 *
 * @param network used when same source, eg: aave has multiple tokens and all of them can be fetched in one call.
 * @param other used for passing mocked data for testing.
 */
export interface AprFetcher {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (network?: Network, other?: any): Promise<{ [address: string]: number }>;
}

const yieldSourceMap: { [address: string]: AprFetcher } = Object.fromEntries([
  ...Object.values(lidoTokens).map((k) => [k, lido]),
  ...Object.values(lidoPolygonTokens).map((k) => [k, lidoPolygon]),
  ...Object.values(aaveTokens).map((k) => [k, aave]),
  ...Object.values(overnightTokens).map((k) => [k, overnight]),
  ...Object.values(rocketpoolTokens).map((k) => [k, rocketpool]),
  ...Object.values(fraxTokens).map((k) => [k, sfrxETH]),
  ...Object.values(staderLabsTokens).map((k) => [k, maticX]),
  ...Object.values(tranchessTokens).map((k) => [k, tranchess]),
  ...Object.values(usdrTokens).map((k) => [k, usdr]),
  ...Object.values(stafiTokens).map((k) => [k, stafi]),
  ...Object.values(tesseraTokens).map((k) => [k, tessera]),
  // ...Object.values(eulerTokens).map((k) => [k, euler]),
  ...Object.values(idleDaiToken).map((k) => [k, idleDai]),
  ...Object.values(idleUsdtToken).map((k) => [k, idleUsdt]),
  ...Object.values(idleUsdcToken).map((k) => [k, idleUsdc]),
  ...Object.values(gearboxTokens).map((k) => [k, gearbox]),
  ...Object.values(reaperTokens).map((k) => [k, reaper]),
]);

export class TokenYieldsRepository implements Findable<number> {
  private yields: { [address: string]: number } = {};

  constructor(private network: Network, private sources = yieldSourceMap) {}

  async fetch(address: string): Promise<void> {
    const tokenYields = await this.sources[address](this.network);
    this.yields = {
      ...this.yields,
      ...tokenYields,
    };
  }

  async find(address: string): Promise<number | undefined> {
    const lowercase = address.toLocaleLowerCase();
    if (
      Object.keys(this.sources).includes(lowercase) &&
      !Object.keys(this.yields).includes(lowercase)
    ) {
      await this.fetch(lowercase);
    }

    return this.yields[lowercase];
  }

  async findBy(attribute: string, value: string): Promise<number | undefined> {
    if (attribute != 'address') {
      return undefined;
    }

    return this.find(value);
  }
}
