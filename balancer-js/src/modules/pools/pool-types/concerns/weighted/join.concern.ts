import { WeightedMaths } from '@balancer-labs/sor';
import { Vault__factory } from '@/contracts/factories/Vault__factory';
import { BigNumber } from '@ethersproject/bignumber';
import { BalancerError, BalancerErrorCode } from '@/balancerErrors';
import { balancerVault } from '@/lib/constants/config';
import { AssetHelpers, getEthValue, parsePoolInfo } from '@/lib/utils';
import { WeightedPoolEncoder } from '@/pool-weighted';
import { subSlippage } from '@/lib/utils/slippageHelper';
import {
  JoinConcern,
  JoinPool,
  JoinPoolAttributes,
  JoinPoolParameters,
} from '../types';
import { Address, Pool } from '@/types';
import { _upscaleArray } from '@/lib/utils/solidityMaths';
import { AddressZero } from '@ethersproject/constants';

type SortedValues = {
  poolTokens: string[];
  weights: bigint[];
  totalSharesEvm: bigint;
  swapFeeEvm: bigint;
  upScaledBalances: bigint[];
  upScaledAmountsIn: bigint[];
  sortedAmountsIn: string[];
};

export class WeightedPoolJoin implements JoinConcern {
  buildJoin = ({
    joiner,
    pool,
    tokensIn,
    amountsIn,
    slippage,
    wrappedNativeAsset,
  }: JoinPoolParameters): JoinPoolAttributes => {
    this.checkInputs(amountsIn, tokensIn, pool);

    const sortedValues = this.sortValues({
      pool,
      wrappedNativeAsset,
      tokensIn,
      amountsIn,
    });

    const { expectedBPTOut, minBPTOut } = this.calcBptOutGivenExactTokensIn({
      ...sortedValues,
      slippage,
    });

    const encodedFunctionData = this.encodeJoinPool({
      ...sortedValues,
      poolId: pool.id,
      joiner,
      minBPTOut,
      tokensIn,
      amountsIn,
    });

    return {
      ...encodedFunctionData,
      minBPTOut,
      expectedBPTOut,
    };
  };

  /**
   * Check if the input parameters of the buildJoin function are right
   * @param amountsIn Must have an amount for each token, if the user will not deposit any amount for a token, the value shall be '0'
   * @param tokensIn Must contain all the tokens of the pool
   * @param pool The pool that is being joined
   */
  checkInputs = (tokensIn: string[], amountsIn: string[], pool: Pool): void => {
    if (
      tokensIn.length != amountsIn.length ||
      tokensIn.length != pool.tokensList.length
    ) {
      throw new BalancerError(BalancerErrorCode.INPUT_LENGTH_MISMATCH);
    }

    // Check if there's any relevant weighted pool info missing
    if (pool.tokens.some((token) => !token.decimals))
      throw new BalancerError(BalancerErrorCode.MISSING_DECIMALS);
    if (pool.tokens.some((token) => !token.weight))
      throw new BalancerError(BalancerErrorCode.MISSING_WEIGHT);
  };

  sortValues = ({
    pool,
    tokensIn,
    amountsIn,
    wrappedNativeAsset,
  }: Pick<
    JoinPoolParameters,
    'pool' | 'wrappedNativeAsset' | 'amountsIn' | 'tokensIn'
  >): SortedValues => {
    const shouldUnwrapNativeAsset = tokensIn.some((a) => a === AddressZero);
    // Parse pool info into EVM amounts in order to match amountsIn scalling
    const parsedPoolInfo = parsePoolInfo(
      pool,
      wrappedNativeAsset,
      shouldUnwrapNativeAsset
    );

    const assetHelpers = new AssetHelpers(wrappedNativeAsset);
    // sort inputs
    const [, sortedAmountsIn] = assetHelpers.sortTokens(
      tokensIn,
      amountsIn
    ) as [string[], string[]];
    const upScaledAmountsIn = _upscaleArray(
      sortedAmountsIn.map(BigInt),
      parsedPoolInfo.scalingFactors
    );
    // sort pool info
    return {
      ...parsedPoolInfo,
      sortedAmountsIn,
      upScaledAmountsIn,
    };
  };

  calcBptOutGivenExactTokensIn = ({
    upScaledBalances,
    weights,
    upScaledAmountsIn,
    totalSharesEvm,
    swapFeeEvm,
    slippage,
  }: Pick<JoinPoolParameters, 'slippage'> &
    Pick<
      SortedValues,
      | 'upScaledBalances'
      | 'weights'
      | 'upScaledAmountsIn'
      | 'totalSharesEvm'
      | 'swapFeeEvm'
    >): { expectedBPTOut: string; minBPTOut: string } => {
    const expectedBPTOut = WeightedMaths._calcBptOutGivenExactTokensIn(
      upScaledBalances,
      weights,
      upScaledAmountsIn,
      totalSharesEvm,
      swapFeeEvm
    ).toString();

    const minBPTOut = subSlippage(
      BigNumber.from(expectedBPTOut),
      BigNumber.from(slippage)
    ).toString();

    return {
      expectedBPTOut,
      minBPTOut,
    };
  };
  encodeJoinPool = ({
    sortedAmountsIn,
    poolTokens,
    poolId,
    joiner,
    minBPTOut,
    amountsIn,
    tokensIn,
  }: Pick<SortedValues, 'sortedAmountsIn' | 'poolTokens'> &
    Pick<JoinPoolParameters, 'joiner' | 'amountsIn' | 'tokensIn'> & {
      joiner: Address;
      poolId: string;
      minBPTOut: string;
    }): Pick<
    JoinPoolAttributes,
    'value' | 'data' | 'to' | 'functionName' | 'attributes'
  > => {
    const userData = WeightedPoolEncoder.joinExactTokensInForBPTOut(
      sortedAmountsIn,
      minBPTOut
    );
    const to = balancerVault;
    const functionName = 'joinPool';
    const attributes: JoinPool = {
      poolId,
      sender: joiner,
      recipient: joiner,
      joinPoolRequest: {
        assets: poolTokens,
        maxAmountsIn: sortedAmountsIn,
        userData,
        fromInternalBalance: false,
      },
    };
    const vaultInterface = Vault__factory.createInterface();
    // encode transaction data into an ABI byte string which can be sent to the network to be executed
    const data = vaultInterface.encodeFunctionData(functionName, [
      attributes.poolId,
      attributes.sender,
      attributes.recipient,
      attributes.joinPoolRequest,
    ]);

    const value = getEthValue(tokensIn, amountsIn);

    return {
      to,
      functionName,
      data,
      attributes,
      value,
    };
  };
}
