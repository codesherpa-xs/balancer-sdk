import { formatFixed, parseFixed } from "@ethersproject/bignumber";
import { BigNumber } from "ethers";

export interface Token {
    address: string;
    decimals: number;
    symbol: string;
    slot?: number;
    price: number;
    twammBalance?: BigNumber;
  }

export interface SwapResult {
    valueOut: number;
    amountOut: number;
    profit: number;
    amountIn: number;
}

export function bigToNumber(amount: BigNumber, token: Token) : number {
    return +bigToStr(amount, token);
}

export function bigToStr(amount: BigNumber, token: Token) : string {
    return formatFixed(amount, token.decimals);
}

export function numberToBigNumber(amount: number, token: Token) : BigNumber {
    return strToBigNumber(amount.toFixed(token.decimals), token);
}

export function strToBigNumber(amount: string, token: Token) : BigNumber {
    return parseFixed(amount, token.decimals)
}

export function strToNumber(amount: string, token: Token) : number {
    return bigToNumber(BigNumber.from(amount), token);
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function valueInDollar(amount: number, token: Token) {
    return amount * token.price;
}

export function bigValueInDollar(amount: BigNumber, token: Token) {
    return bigToNumber(amount, token) * token.price;
}

// Moved here from arbitrage4.ts for future use.
// async function getTwammSwapValue(tokenIn: Token, tokenOut: Token, amountIn: number): Promise<SwapResult> {
//     if (tokenIn.price && tokenOut.price) {
//         let amountOut;
//         try {
//             amountOut = await staticTwammSwap(tokenIn, tokenOut, amountIn);
//         } catch {
//             amountOut = -10;
//         }

//         let amountOutValue = amountOut * tokenOut.price;

//         console.log(
//             `${amountIn} ${tokenIn.symbol} ($${amountIn * tokenIn.price}) ->`,
//             `${amountOut} ${tokenOut.symbol} ($${amountOutValue})`);
//         return {
//             valueOut: amountOutValue,
//             amountIn: amountIn,
//             amountOut: amountOut,
//             profit: amountOutValue - (amountIn * tokenIn.price)
//         };
//     }
//     return { valueOut: 0, amountOut: 0, profit: 0, amountIn: amountIn };
// }

// async function staticTwammSwap(tokenIn: Token, tokenOut: Token, amountIn: number) {
//     const vault = balancer.contracts.vault?.connect(wallet);
//     const amountOut = bigToNumber(await vault.callStatic.swap(
//         {
//             poolId: TWAMM_POOL_ID,
//             kind: 0,
//             assetIn: tokenIn.address,
//             assetOut: tokenOut.address,
//             amount: numberToBigNumber(amountIn, tokenIn),
//             userData: '0x',
//         },
//         {
//             sender: wallet.address,
//             fromInternalBalance: false,
//             recipient: wallet.address,
//             toInternalBalance: true,
//         },
//         0,
//         MaxUint256
//     ), tokenOut);
//     debug(`Static TWAMM swap: ${amountIn.toString()} ${tokenIn.symbol} -> ${amountOut} ${tokenOut.symbol}`);
//     return amountOut;
// }