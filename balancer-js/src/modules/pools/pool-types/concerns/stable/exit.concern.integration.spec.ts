// yarn test:only ./src/modules/pools/pool-types/concerns/stable/exit.concern.integration.spec.ts
import { parseFixed } from '@ethersproject/bignumber';
import dotenv from 'dotenv';
import { ethers } from 'hardhat';

import { getPoolAddress, Network, PoolWithMethods } from '@/.';
import { BPT_DECIMALS, BPT_SLOT } from '@/lib/constants/config';
import { forkSetup, TestPoolHelper } from '@/test/lib/utils';
import { testExactBptIn, testExactTokensOut } from '@/test/lib/exitHelper';

dotenv.config();

const { ALCHEMY_URL: jsonRpcUrl } = process.env;
const rpcUrl = 'http://127.0.0.1:8545';
const network = Network.MAINNET;
const provider = new ethers.providers.JsonRpcProvider(rpcUrl, network);
const signer = provider.getSigner();

describe('StablePool', async () => {
  let pool: PoolWithMethods;
  // This blockNumber is before protocol fees were switched on (Oct `21), for blockNos after this tests will fail because results don't 100% match
  const blockNumber = 13309758;
  const testPoolId =
    '0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063';
  // Setup chain
  context('exit pool functions', async () => {
    beforeEach(async () => {
      // Setup forked network, set initial token balances and allowances
      await forkSetup(
        signer,
        [getPoolAddress(testPoolId)],
        [BPT_SLOT],
        [parseFixed('10000', BPT_DECIMALS).toString()],
        jsonRpcUrl as string,
        blockNumber
      );
      // Updatate pool info with onchain state from fork block no
      const testPoolHelper = new TestPoolHelper(
        testPoolId,
        network,
        rpcUrl,
        blockNumber
      );
      pool = await testPoolHelper.getPool();
    });
    context('buildExitExactBPTIn', async () => {
      it('single token max out', async () => {
        const bptIn = parseFixed('10', 18).toString();
        const tokenOut = pool.tokensList[0];
        await testExactBptIn(pool, signer, bptIn, tokenOut);
      });
      it('proportional exit', async () => {
        const bptIn = parseFixed('10', 18).toString();
        await testExactBptIn(pool, signer, bptIn);
      });
    });

    context('buildExitExactTokensOut', async () => {
      it('all tokens with value', async () => {
        const tokensOut = pool.tokensList;
        const amountsOut = pool.tokens.map((t, i) =>
          parseFixed(((i + 1) * 100).toString(), t.decimals).toString()
        );
        await testExactTokensOut(pool, signer, tokensOut, amountsOut);
      });
      it('single token with value', async () => {
        const tokensOut = pool.tokensList;
        const amountsOut = Array(tokensOut.length).fill('0');
        amountsOut[0] = parseFixed('100', pool.tokens[0].decimals).toString();
        await testExactTokensOut(pool, signer, tokensOut, amountsOut);
      });
    });
  });
});
