import dotenv from 'dotenv';
import { BalancerSDK, Network, Swaps, SwapType, SwapTypes } from '../src';
import { BalancerSdkConfig } from '../src/types';
import { ADDRESSES } from '../src/test/lib/constants';
import { BigNumber } from '@ethersproject/bignumber';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider, AlchemyProvider, Block } from '@ethersproject/providers';
import { balancerVault } from '../src/lib/constants/config';
import { bigToNumber, bigValueInDollar, numberToBigNumber, sleep, strToNumber, SwapResult, Token, valueInDollar } from './arbitrageUtils';
import { exit } from 'process';
import { FlashbotsBundleProvider, FlashbotsTransactionResolution } from "@flashbots/ethers-provider-bundle";

dotenv.config();
const { TWAMM_POOL, KNOWN_POOL, TOKEN_1, TOKEN_2, TRADER_KEY } = process.env;
const TWAMM_POOL_ID = TWAMM_POOL || '';
const KNOWN_POOL_ID = KNOWN_POOL || '';
const TOKEN1: string = TOKEN_1 || 'USDC';
const TOKEN2: string = TOKEN_2 || 'WETH';

const debug = require('debug')('arbitrage:bot4');

const network = Network.MAINNET;

const LOCAL_RPC_URL = `http://localhost:8545`;
const LOCAL_PROVIDER = new JsonRpcProvider(LOCAL_RPC_URL, network);

const ALCHEMY_RPC_URL = `${process.env.ALCHEMY_URL}`;
const ALCHEMY_PROVIDER = new AlchemyProvider(network, `${process.env.ALCHEMY_KEY}`)

let provider: JsonRpcProvider, rpcUrl;
let FB_PROVIDER: FlashbotsBundleProvider;

const FB_KEY = `${process.env.FB_KEY}`;
let FB_ATTEMPTS = 0;

if (process.argv.indexOf('local') > -1) {
    provider = LOCAL_PROVIDER;
    rpcUrl = LOCAL_RPC_URL;
} else if (process.argv.indexOf('live') > -1) {
    provider = ALCHEMY_PROVIDER;
    rpcUrl = ALCHEMY_RPC_URL;
} else {
    console.log("Please provide 'live' or 'local' command line argument.");
    exit();
}
const wallet = new Wallet(TRADER_KEY as string, provider);

const config: BalancerSdkConfig = { network, rpcUrl };
const balancer = new BalancerSDK(config);

function findToken(symbol: string) {
    let token = Object.values(ADDRESSES[network]).filter(v => 'symbol' in v && v.symbol == symbol)[0];
    if(!('symbol' in token) || !('decimals' in token)) {
        throw Error('Bad config');
    }
    return token;
}

let ETH: Token = { ...ADDRESSES[network].ETH, price: 1700 };
let token1: Token = { ...findToken(TOKEN1), price: 1 };
let token2: Token = { ...findToken(TOKEN2), price: 1800 };

let currentBlockNumber: number;
let currentBlock: Block;
let currentWalletNonce: number;

let localPoolsFetched = false;
let balancerSdkLocal: BalancerSDK;

async function populateTwammBalance(token: Token) {
    return (await balancer.contracts.vault.getPoolTokenInfo(TWAMM_POOL_ID, token.address))[0];
}

async function getUnitSwapValue(tokenIn: Token, tokenOut: Token) {
    if (tokenIn.price) {
        let valueIn = 1;
        for (let i = 0; i < 10; i++) {
            // Note: Querying flash swap, so we can get values without necessarily holding reqd
            // balances. This requires known pool to have good liquidity.
            // Can maybe replace with QuerySwap.
            const response = await querySimpleFlashSwap(tokenIn, tokenOut, valueIn / tokenIn.price);
            debug(response);

            if (response.valueOut > 0) {
                let spotPrice = 0;
                if(tokenIn.price > tokenOut.price) {
                    spotPrice = response.amountOut * tokenIn.price / valueIn;
                } else {
                    spotPrice = valueIn / (response.amountOut * tokenIn.price);
                }
                console.log(`TokenIn: ${tokenIn.symbol}, spotPrice: ${spotPrice}`);
                // Normalize to $1 worth value in.
                let result = {
                    value: response.valueOut / valueIn,
                    amount: response.amountOut / valueIn,
                    profit: response.profit / valueIn,
                    spotPrice: spotPrice
                };
                debug(result);
                return result;
            }
            // If amount too low, multiply by 2 and normalize on return above.
            valueIn *= 2;
        }
    }
    return { value: 0, amount: 0, profit: 0, spotPrice: 0 };
}

async function discoverMinLimit(tokenIn: Token, tokenOut: Token) {
    // Check if $1 worth of tokens can be swapped.
    let result = (await querySimpleFlashSwap(tokenIn, tokenOut, 1 / tokenIn.price));
    if (result.valueOut > 0) {
        return { amount: 1 / tokenIn.price, profit: result.profit };
    }

    let amountInvalid = 1 / tokenIn.price; // Assume min swap worth $1.
    let amountValid = 100 / tokenIn.price; // Check upto $100 for min limit.
    let profit = -10;

    // Do a binary search to discover actual min value.
    for (let i = 0; i < 10; i++) {
        let amount = (amountInvalid + amountValid) / 2;
        let result = (await querySimpleFlashSwap(tokenIn, tokenOut, amount));
        if (result.valueOut - valueInDollar(amount, tokenIn) > 0) {
            amountValid = amount;
            profit = result.profit;
        } else {
            amountInvalid = amount;
        }
        if (Math.abs(valueInDollar(amount, tokenIn) - valueInDollar(amountValid, tokenIn)) < 1) {
            break;
        }
    }
    return { amount: amountValid, profit: profit };
}

async function discoverMaxLimit(tokenIn: Token, tokenOut: Token) {
    let amountInvalid = 1e5 / tokenIn.price; // Assume max swap worth $100k or pool balance/3.
    let amountValid = 50 / tokenIn.price; // Assume lowest (upper limit) swap worth $50.
    if (tokenIn.twammBalance) {
        const twammBalance = bigToNumber(tokenIn.twammBalance, tokenIn);
        amountInvalid = twammBalance / 2;
    }
    let result = (await querySimpleFlashSwap(tokenIn, tokenOut, amountInvalid));
    if (result.valueOut > 0) {
        return { amount: amountInvalid, profit: result.profit };
    }

    let profit = (await querySimpleFlashSwap(tokenIn, tokenOut, amountValid)).profit;

    // Do a binary search to discover actual max value.
    for (let i = 0; i < 15; i++) {
        let amount = (amountInvalid + amountValid) / 2;
        let result = await querySimpleFlashSwap(tokenIn, tokenOut, amount);
        // TODO: can we only search for profitable limit?
        if (result.valueOut > 0 && result.profit > profit) {
            amountValid = amount;
            profit = result.profit;
        } else {
            amountInvalid = amount;
        }
        if (Math.abs(valueInDollar(amount, tokenIn) - valueInDollar(amountValid, tokenIn)) < 1) {
            break;
        }
    }
    return { amount: amountValid, profit: profit };
}

async function binarySearch(tokenIn: Token, tokenOut: Token) {
    // Find swap limits.
    console.time("Discover limits");
    let min = 0, minProfit = 0, max = 0, maxProfit = 0;
    let minPromise = discoverMinLimit(tokenIn, tokenOut).then(minResult => {
        min = minResult.amount;
        minProfit = minResult.profit;
    });

    let maxPromise = discoverMaxLimit(tokenIn, tokenOut).then(maxResult => {
        max = maxResult.amount;
        maxProfit = maxResult.profit;
    });
    await Promise.all([minPromise, maxPromise]);
    console.timeEnd("Discover limits");

    console.log("*Discovered limits:", min, max, minProfit, maxProfit);

    let bestResult: SwapResult = { valueOut: 0, amountOut: 0, profit: -1000, amountIn: 0 };

    for (let i = 0; i < 20; i++) {
        // Binary search to find the amountIn for max amountOut.
        let x = (min + max) / 2;

        let result = await querySimpleFlashSwap(tokenIn, tokenOut, x);
        if (result.profit > bestResult.profit) {
            if (result.profit - bestResult.profit < 0.01) {
                debug("Converged", x, result);
                return result;
            }
            // bestResult.profit = result.profit;
            bestResult = result;
        }

        if (result.profit < Math.min(maxProfit, minProfit)) break;

        if (minProfit > maxProfit) {
            maxProfit = result.profit;
            max = x;
        } else {
            minProfit = result.profit;
            min = x;
        }

        debug(min, max, minProfit, maxProfit);
    }
    return bestResult;
}

async function buildSwapTxn(token1: Token, token2: Token, amount: BigNumber) {

    const timestamp = (await provider.getBlock(currentBlockNumber)).timestamp;

    return {
        kind: SwapType.SwapExactIn,
        swaps: [
            {
                poolId: TWAMM_POOL_ID,
                assetInIndex: 0,
                assetOutIndex: 1,
                amount: amount.toString(),
                userData: '0x',
            },
            {
                poolId: KNOWN_POOL_ID,
                assetInIndex: 1,
                assetOutIndex: 0,
                amount: '0',
                userData: '0x',
            },
        ],
        assets: [
            token1.address, token2.address
        ],
        funds: {
            fromInternalBalance: false,
            // These can be different addresses!
            recipient: wallet.address,
            sender: wallet.address,
            toInternalBalance: true,
        },
        limits: ['0', '0'], // +ve for max to send, -ve for min to receive
        deadline: (timestamp + 120).toString(), // Current block timestamp + 120 seconds.
    }
}

async function calcAdditionalGasPrice(amount: number, gasEstimate: BigNumber) {
    // amount * 1e18/ (ethPrice * gasEstimate)
    let maxPriorityFeePerGas = numberToBigNumber(amount, ETH)
        .div(gasEstimate)
        .div(BigNumber.from(~~ETH.price));

    let feeData = await provider.getFeeData();
    if (feeData.maxPriorityFeePerGas && maxPriorityFeePerGas.gt(feeData.maxPriorityFeePerGas)) {
        return feeData.maxPriorityFeePerGas;
    }
    return maxPriorityFeePerGas;
}

async function logBalances(token1: Token, token2: Token) {
    // TODO: track overall profit and deltas.
    let ethBalance = await wallet.getBalance();
    let internalBalances = await balancer.contracts.vault.getInternalBalance(
        wallet.address,
        [token1.address, token2.address]
    );

    if (ETH.price && token1.price && token2.price) {
        console.log("ETH:", bigToNumber(ethBalance, ETH), bigToNumber(ethBalance, ETH) * ETH.price);
        console.log(`${token1.symbol}:`, bigToNumber(internalBalances[0], token1), bigToNumber(internalBalances[0], token1) * token1.price);
        console.log(`${token2.symbol}:`, bigToNumber(internalBalances[1], token2), bigToNumber(internalBalances[1], token2) * token2.price);
        let total = bigToNumber(ethBalance, ETH) * ETH.price + bigToNumber(internalBalances[0], token1) * token1.price + bigToNumber(internalBalances[1], token2) * token2.price;
        console.log(`Total account value: ${total}`);
    }
}

async function placeSwap(encodedBatchSwapData: string, profitAfterGas: number, gasEstimate: BigNumber) {
    try {
        console.log(`Balances before: `);
        await logBalances(token1, token2);

        console.time("sendTransaction");
        let additionalGas = await calcAdditionalGasPrice(Math.abs(profitAfterGas) * 0.2, gasEstimate);

        console.log("maxPriorityFeePerGas", bigValueInDollar(additionalGas.mul(gasEstimate), ETH), additionalGas.toString());

        if (!currentBlock.baseFeePerGas) return;
        const maxBaseFeeInFutureBlock = FlashbotsBundleProvider.getMaxBaseFeeInFutureBlock(currentBlock.baseFeePerGas, 3);

        const tx = {
            data: encodedBatchSwapData,
            type: 2,
            from: wallet.address,
            to: balancerVault,
            value: '0',
            /**
             * The following gas inputs are optional,
             **/
            maxPriorityFeePerGas: additionalGas,
            maxFeePerGas: additionalGas.add(maxBaseFeeInFutureBlock),
            gasLimit: (~~(gasEstimate.toNumber() * 1.05)).toString(),
            chainId: 1,
            nonce: currentWalletNonce
        };

        let res;
        if (local() || !FB_PROVIDER || FB_ATTEMPTS >= 2 || profitAfterGas < 0.5) {
            FB_ATTEMPTS = 0;
            res = await wallet.sendTransaction(tx);
        } else {
            console.log("Placing order via Flashbots.");
            FB_ATTEMPTS += 1;
            const privateTx = {
                transaction: tx,
                signer: wallet,
            }
            const maxBlockNumber = currentBlockNumber + 3;
            res = await FB_PROVIDER.sendPrivateTransaction(
                privateTx,
                { maxBlockNumber }

            );
        }
        console.timeEnd("sendTransaction");

        // Fetch pools while placing every order to keep SOR fresh.
        if (!local()) fetchPools(balancer);

        // TODO: time out after 30 seconds?
        if (!("error" in res)) {
            if ("simulate" in res) debug(await res.simulate());
            const waitRes = await res.wait();
            if (waitRes === FlashbotsTransactionResolution.TransactionIncluded) {
                console.log("Private transaction INCLUDED.")
                FB_ATTEMPTS = 0;
            } else if (waitRes === FlashbotsTransactionResolution.TransactionDropped) {
                console.log("Private transaction NOT included.")
                return;
            } else {
                debug(waitRes);
            }
        } else {
            console.log(res.error);
        }
        console.log(`Balances after: `);
        await logBalances(token1, token2);
    } catch (err) {
        console.log(err);
    }

}

async function buildKnownBatchSwap(tokenIn: Token, tokenOut: Token, twammSwapData: SwapResult) {
    let emptyResponse = { profitable: false, txn: '', profit: -1000, gasEstimate: BigNumber.from(0) };

    try {
        let customBatchSwap = await buildSwapTxn(tokenIn, tokenOut, numberToBigNumber(twammSwapData.amountIn, tokenIn));
        const deltas = await balancer.contracts.vault.callStatic.queryBatchSwap(
            customBatchSwap.kind,
            customBatchSwap.swaps,
            customBatchSwap.assets,
            customBatchSwap.funds);
        debug("Known BatchSwap Deltas", deltas.toString());
        if (deltas[0].gt(0)) {
            return emptyResponse;
        }
        const vault = balancer.contracts.vault?.connect(wallet);
        const gasEstimate = await vault.estimateGas.batchSwap(
            customBatchSwap.kind,
            customBatchSwap.swaps,
            customBatchSwap.assets,
            customBatchSwap.funds,
            customBatchSwap.limits,
            customBatchSwap.deadline);
        const gasPrice = await wallet.provider.getGasPrice();
        const gasDollarValue = bigToNumber(gasEstimate.mul(gasPrice), ETH) * ETH.price;

        const overallDelta = -bigToNumber(deltas[0], tokenIn);
        const profitBeforeGas = overallDelta * tokenIn.price;
        const profitAfterGas = profitBeforeGas - gasDollarValue;
        console.log(`Known batch swap: ${profitBeforeGas} - ${gasDollarValue} = ${profitAfterGas}`);

        if (profitAfterGas < 0) {
            let encodedBatchSwapData = Swaps.encodeBatchSwap(customBatchSwap);

            return { profitable: false, txn: encodedBatchSwapData, profit: profitAfterGas, gasEstimate };
        } else {
            let encodedBatchSwapData = Swaps.encodeBatchSwap(customBatchSwap);

            return { profitable: true, txn: encodedBatchSwapData, profit: profitAfterGas, gasEstimate };
        }
    } catch (err) {
        console.log(err);
    }

    return emptyResponse;
}

async function fetchPools(balancer: BalancerSDK) {
    console.time("fetchPools");
    const poolsFetched = await balancer.swaps.fetchPools();
    if (!poolsFetched) {
        throw new Error(`Error fetching pools data.`);
    }
    console.timeEnd("fetchPools");
}

async function querySimpleFlashSwap(tokenIn: Token, tokenOut: Token, amountIn: number) { // amountIn is number of tokens.
    try {
        let balancerSdk: BalancerSDK;
        if (local()) {
            if (!localPoolsFetched) {
                // TODO: refactor into helper lib.
                const config: BalancerSdkConfig = {
                    network: Network.MAINNET,
                    rpcUrl: `https://mainnet.infura.io/v3/${process.env.INFURA}`,
                };
                balancerSdkLocal = new BalancerSDK(config);
                await fetchPools(balancerSdkLocal);
                localPoolsFetched = true;
            }
            balancerSdk = balancerSdkLocal;
        } else {
            balancerSdk = balancer;
        }

        const response = await balancer.swaps.querySimpleFlashSwap({
            flashLoanAmount: numberToBigNumber(amountIn, tokenIn).toString(),
            poolIds: [
                TWAMM_POOL_ID,
                KNOWN_POOL_ID,
            ],
            assets: [tokenIn.address, tokenOut.address],
        });
        debug('Query Flash Swap', response);
        if (response.profits) {
            const profitAmount = strToNumber(response.profits[tokenIn.address], tokenIn);
            const profitValue = profitAmount * tokenIn.price;
            const valueOut = (amountIn + profitAmount) * tokenIn.price;
            const amountOut = valueOut / tokenOut.price;
            return { valueOut: valueOut, amountOut: amountOut, profit: profitValue, amountIn: amountIn };
        }
    } catch (err) {
    }

    return { valueOut: -10, amountOut: -10, profit: -1000, amountIn: amountIn };
}

async function queryBatchSwap(tokenIn: Token, tokenOut: Token, twammSwapData: SwapResult) {
    let balancerSdk: BalancerSDK;
    if (local()) {
        if (!localPoolsFetched) {
            const config: BalancerSdkConfig = {
                network: Network.MAINNET,
                rpcUrl: `https://mainnet.infura.io/v3/${process.env.INFURA}`,
            };
            balancerSdkLocal = new BalancerSDK(config);
            await fetchPools(balancerSdkLocal);
            localPoolsFetched = true;
        }
        balancerSdk = balancerSdkLocal;
    } else {
        balancerSdk = balancer;
    }


    // Find the best batch swap in tokenOut -> tokenIn direction.
    // Find best conversion for twammSwapData.amountOut.
    const swapInfo = await balancerSdk.swaps.sor.getSwaps(
        tokenOut.address,
        tokenIn.address,
        SwapTypes.SwapExactIn,
        numberToBigNumber(twammSwapData.amountOut, tokenOut),
        undefined,
        false
    );

    if (swapInfo.returnAmount.isZero()) {
        throw new Error(`Could not find a good batch swap via SOR. returnAmount: ${swapInfo.returnAmount.toString()}`);
    }

    debug("swapInfo", swapInfo);

    debug(`Return amount: `, tokenIn.symbol, swapInfo.returnAmount.toString(), bigToNumber(swapInfo.returnAmount, tokenIn) * tokenIn.price);

    if (bigToNumber(swapInfo.returnAmount, tokenIn) < twammSwapData.amountIn) {
        // Not profitable.
        throw new Error(`Got only ${tokenIn.symbol} ${swapInfo.returnAmount.toString()} for ${twammSwapData.amountIn}`);
    }

    return balancerSdk.swaps.buildSwap({
        userAddress: wallet.address,
        swapInfo,
        kind: 0,
        deadline: BigNumber.from(`${Math.ceil(Date.now() / 1000) + 120}`), // 120 seconds from now,
        maxSlippage: 50,
    });
}



async function buildSorBatchSwap(tokenIn: Token, tokenOut: Token, twammSwapData: SwapResult) {
    let emptyResponse = { profitable: false, txn: '', profit: -1000, gasEstimate: BigNumber.from(0) };
    try {
        const transactionAttributes = await queryBatchSwap(tokenIn, tokenOut, twammSwapData);

        if (!transactionAttributes) {
            return emptyResponse;
        }

        const { attributes } = transactionAttributes;


        if ("kind" in attributes) {
            let customBatchSwap = {
                ...attributes,
                swaps: [
                    {
                        poolId: TWAMM_POOL_ID,
                        assetInIndex: attributes.assets.length - 1,
                        assetOutIndex: 0,
                        amount: numberToBigNumber(twammSwapData.amountIn, tokenIn).toString(),
                        userData: '0x',
                    },
                    ...attributes.swaps,
                ],
                limits: Array<string>(attributes.assets.length).fill('0')
            }
            customBatchSwap.swaps[1].amount = '0';
            debug("customBatchSwap", customBatchSwap);
            const deltas = await balancer.contracts.vault.callStatic.queryBatchSwap(
                customBatchSwap.kind,
                customBatchSwap.swaps,
                customBatchSwap.assets,
                customBatchSwap.funds);
            debug("SOR batch swap Deltas", deltas.toString(), customBatchSwap.limits);
            if (deltas[attributes.assets.length - 1].gt(0)) {
                return emptyResponse;
            }
            const vault = balancer.contracts.vault?.connect(wallet);
            const gasEstimate = await vault.estimateGas.batchSwap(
                customBatchSwap.kind,
                customBatchSwap.swaps,
                customBatchSwap.assets,
                customBatchSwap.funds,
                customBatchSwap.limits,
                customBatchSwap.deadline);
            const gasPrice = await wallet.provider.getGasPrice();
            const gasDollarValue = bigToNumber(gasEstimate.mul(gasPrice), ETH) * ETH.price;

            const overallDelta = bigToNumber(deltas[customBatchSwap.assets.length - 1], tokenIn);
            const profitBeforeGas = -overallDelta * tokenIn.price;
            const profitAfterGas = profitBeforeGas - gasDollarValue;
            console.log(`SOR swap: ${profitBeforeGas} - ${gasDollarValue} = ${profitAfterGas}`);

            if (profitAfterGas < 0) {
                let encodedBatchSwapData = Swaps.encodeBatchSwap(customBatchSwap);
                return { profitable: false, txn: encodedBatchSwapData, profit: profitAfterGas, gasEstimate };
            } else {
                let encodedBatchSwapData = Swaps.encodeBatchSwap(customBatchSwap);

                return { profitable: true, txn: encodedBatchSwapData, profit: profitAfterGas, gasEstimate };
            }
        }
    } catch (err) {
        console.log(err);
    }
    return emptyResponse;
}

function local() {
    return process.argv.indexOf('local') > -1;
}

export async function fetchPrices() {
    const ps = [token1, token2].map((t) => balancer.data.tokenPrices.find(t.address));
    const price = await Promise.all(ps);

    debug(ETH, token1, token2);

    if (price[0]?.usd) {
        token1.price = +price[0].usd;
        if (price[0]?.eth) ETH.price = (+price[0].usd)/(+price[0].eth);
    }
    if (price[1]?.usd) {
        token2.price = +price[1].usd;
        if (price[1]?.eth) ETH.price = (+price[1].usd)/(+price[1].eth);
    }
}


function spotPricesSkewed(token1UnitSwapValue: any, token2UnitSwapValue: any): boolean {
    let baseToken, mainToken: Token;
    let mainTokenSpotPrice, baseTokenSpotPrice: number;
    if(token1.price > token2.price) {
        baseToken = token2;
        mainToken = token1;
        mainTokenSpotPrice = token1UnitSwapValue.spotPrice;
        baseTokenSpotPrice = token2UnitSwapValue.spotPrice;
    } else {
        baseToken = token1;
        mainToken = token2;
        mainTokenSpotPrice = token2UnitSwapValue.spotPrice;
        baseTokenSpotPrice = token1UnitSwapValue.spotPrice;
    }

    if( baseTokenSpotPrice == 0) {
        console.log("Invalid spot price");
        return false;
    }

    if( mainTokenSpotPrice > mainToken.price * 1.03 || baseTokenSpotPrice < mainToken.price / 1.03) {
        return true;
    }

    console.log("Not enough skew to generate profit");
    console.log(token1UnitSwapValue, token2UnitSwapValue);
    return false;
}


async function arbitrage() {

    console.log("Running against local:", process.argv.indexOf('local') > -1);
    if (local()) {
        await provider.send("hardhat_setNextBlockBaseFeePerGas", [
            "0x37E11D600", // 15 gwei
          ]);
    } else {
        const authSigner = new Wallet(FB_KEY, provider);
        // Flashbots provider requires passing in a standard provider
        FB_PROVIDER = await FlashbotsBundleProvider.create(
            provider, // a normal ethers.js provider, to perform gas estimiations and nonce lookups
            authSigner // ethers.js signer wallet, only for signing request payloads, not transactions
        )

        await fetchPools(balancer);
    }


    token1 = { ...token1, twammBalance: await populateTwammBalance(token1) };
    token2 = { ...token2, twammBalance: await populateTwammBalance(token2) };
    await fetchPrices();

    let prevBlockNumber = 0;

    console.log("Initial balances:");
    await logBalances(token1, token2);

    while (1) {
        try {
            currentBlockNumber = await provider.getBlockNumber();

            if (currentBlockNumber === prevBlockNumber) {
                if (local()) {
                    await provider.send("hardhat_setNextBlockBaseFeePerGas", [
                        "0x37E11D600", // 15 gwei
                      ]);
                    await provider.send("hardhat_mine", ["0x1"]);
                } else await sleep(100);
                continue;
            }
            prevBlockNumber = currentBlockNumber;
            provider.getBlock(currentBlockNumber).then(block => {
                currentBlock = block;
                console.log("BaseFee:", currentBlock.baseFeePerGas?.toString());
            }).catch(error => console.log(error));
            provider.getTransactionCount(wallet.address).then(nonce => {
                currentWalletNonce = nonce;
            }).catch(error => console.log(error));
            
            console.time(currentBlockNumber.toString());

            console.log("\n\nCurrent block:", currentBlockNumber);
            fetchPrices();

            // Discover better spot price direction.
            let token1UnitSwapValue = (await getUnitSwapValue(token1, token2));
            let token2UnitSwapValue = (await getUnitSwapValue(token2, token1));

            if(!spotPricesSkewed(token1UnitSwapValue, token2UnitSwapValue)) {
                console.timeEnd(currentBlockNumber.toString());
                await sleep(100);
                continue;
            }

            let tokenIn, tokenOut: Token;
            let bsResult: SwapResult;
            // Binary search in the higher unit swap value direction.
            if (token1UnitSwapValue.value >= token2UnitSwapValue.value) {

                if (token1UnitSwapValue.spotPrice > token1.price)

                console.time(`binarySearch ${token1.symbol}`);
                bsResult = await binarySearch(token1, token2);
                console.timeEnd(`binarySearch ${token1.symbol}`);

                tokenIn = token1;
                tokenOut = token2;
            } else {
                console.time(`binarySearch ${token2.symbol}`);
                bsResult = await binarySearch(token2, token1);
                console.timeEnd(`binarySearch ${token2.symbol}`);

                tokenIn = token2;
                tokenOut = token1;
            }

            console.log(`Best trade: ${bsResult.amountIn} ${tokenIn.symbol} ($${valueInDollar(bsResult.amountIn, tokenIn)}) -> ${tokenOut.symbol}`);
            console.log(bsResult);

            // TODO: Replace 1.5 with num calculated using live gas price.
            // Skip if profit before gas is less than $1.5.
            if (bsResult.profit < 1.5) {
                console.timeEnd(currentBlockNumber.toString());
                await sleep(100);
                continue;
            }

            // SOR batch swap.
            let querySorBatchSwap = buildSorBatchSwap(tokenIn, tokenOut, bsResult).then((result) => {
                console.log(`SOR batch swap: profitable=${result.profitable}, profit=${result.profit}`);
                return result;
            });

            // Known batch swap.
            let queryKnownBatchSwap = buildKnownBatchSwap(tokenIn, tokenOut, bsResult).then((result) => {
                console.log(`Known batch swap: profitable=${result.profitable}, profit=${result.profit}`);
                return result;
            });

            let sorResult = await querySorBatchSwap;
            let knownResult = await queryKnownBatchSwap;

            console.time("Place swap");
            if (sorResult.profitable && knownResult.profitable) {
                if (sorResult.profit > knownResult.profit) {
                    console.log("Swapping against SOR batch swap.");
                    await placeSwap(sorResult.txn, sorResult.profit, sorResult.gasEstimate);
                } else {
                    console.log("Swapping against Known batch swap.");
                    await placeSwap(knownResult.txn, knownResult.profit, knownResult.gasEstimate);
                }
            } else if (sorResult.profitable) {
                console.log("Swapping against SOR batch swap.");
                await placeSwap(sorResult.txn, sorResult.profit, sorResult.gasEstimate);
            } else if (knownResult.profitable) {
                console.log("Swapping against Known batch swap.");
                await placeSwap(knownResult.txn, knownResult.profit, knownResult.gasEstimate);
            }
            console.timeEnd("Place swap");
            console.timeEnd(currentBlockNumber.toString());
        } catch (err) {
            console.log(err);
        }
    }
}

// yarn examples:run ./examples/arbitrage4.ts local
arbitrage();