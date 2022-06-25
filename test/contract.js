const et = require("euler-contracts/test/lib/eTestLib.js").config(
	`${__dirname}/lib/eTestLib.config.js`,
)
const { provisionUniswapPool, deposit } = require("./lib/helpers")

et.testSet({
	desc: "bot contract",
	fixture: "testing-real-uniswap-activated",

	preActions: (ctx) => [
		// deployBot(ctx),

		{ action: "setIRM", underlying: "WETH", irm: "IRM_ZERO" },
		{ action: "setIRM", underlying: "TST", irm: "IRM_ZERO" },
		{ action: "setIRM", underlying: "TST2", irm: "IRM_ZERO" },
		{ action: "setAssetConfig", tok: "WETH", config: { borrowFactor: 0.4 } },
		{ action: "setAssetConfig", tok: "TST", config: { borrowFactor: 0.4 } },
		{ action: "setAssetConfig", tok: "TST2", config: { borrowFactor: 0.4 } },

		// wallet is lender and liquidator
		...deposit(ctx, "TST"),
		...deposit(ctx, "WETH"),

		// wallet2 is borrower/violator
		...deposit(ctx, "TST2", ctx.wallet2),
		{
			from: ctx.wallet2,
			send: "markets.enterMarket",
			args: [0, ctx.contracts.tokens.TST2.address],
		},

		// wallet 5 is the super whale
		...provisionUniswapPool(ctx, "TST/WETH", ctx.wallet5, et.eth(1000)),
		...provisionUniswapPool(ctx, "TST2/WETH", ctx.wallet5, et.eth(1000)),
		...provisionUniswapPool(ctx, "TST3/WETH", ctx.wallet5, et.eth(1000)),

		// initial prices
		{
			from: ctx.wallet5,
			action: "doUniswapSwap",
			tok: "TST",
			dir: "buy",
			amount: et.eth(10_000),
			priceLimit: 2.2,
		},
		{
			from: ctx.wallet5,
			action: "doUniswapSwap",
			tok: "TST2",
			dir: "sell",
			amount: et.eth(10_000),
			priceLimit: 0.4,
		},
		{
			from: ctx.wallet5,
			action: "doUniswapSwap",
			tok: "TST3",
			dir: "buy",
			amount: et.eth(10_000),
			priceLimit: 1.7,
		},

		// wait for twap
		{ action: "checkpointTime" },
		{ action: "jumpTimeAndMine", time: 3600 * 30 },
	],
})

	.test({
		desc: "basic full liquidation",
		actions: (ctx) => [
			{ from: ctx.wallet2, send: "dTokens.dTST.borrow", args: [0, et.eth(5)] },

			{
				callStatic: "exec.liquidity",
				args: [ctx.wallet2.address],
				onResult: (r) => {
					et.equals(r.collateralValue / r.liabilityValue, 1.09, 0.01)
				},
			},

			{
				from: ctx.wallet5,
				action: "doUniswapSwap",
				tok: "TST",
				dir: "buy",
				amount: et.eth(10_000),
				priceLimit: 2.5,
			},

			{ action: "checkpointTime" },
			{ action: "jumpTimeAndMine", time: 3600 * 30 * 100 },

			{
				callStatic: "exec.liquidity",
				args: [ctx.wallet2.address],
				onResult: (r) => {
					et.equals(r.collateralValue / r.liabilityValue, 0.96, 0.001)
				},
			},

			{
				callStatic: "liquidation.checkLiquidation",
				args: [
					ctx.wallet.address,
					ctx.wallet2.address,
					ctx.contracts.tokens.TST.address,
					ctx.contracts.tokens.TST2.address,
				],
				onResult: (r) => {
					et.equals(r.healthScore, 0.96, 0.001)
					ctx.stash.repay = r.repay
					ctx.stash.yield = r.yield
				},
			},

			{ action: "snapshot" },

			// liquidate with the bot
			{
				send: "liquidationBot.liquidate",
				args: [
					async () => ({
						eulerAddr: ctx.contracts.euler.address,
						liquidationAddr: ctx.contracts.liquidation.address,
						execAddr: ctx.contracts.exec.address,
						swapAddr: ctx.contracts.swap.address,
						marketsAddr: ctx.contracts.markets.address,

						swapPath: await ctx.encodeUniswapPath(
							["TST2/WETH", "TST/WETH"],
							"TST2",
							"TST",
							true,
						),

						violator: ctx.wallet2.address,
						underlying: ctx.contracts.tokens.TST.address,
						collateral: ctx.contracts.tokens.TST2.address,
					}),
				],
			},

			{
				callStatic: "liquidation.checkLiquidation",
				args: [
					ctx.wallet.address,
					ctx.wallet2.address,
					ctx.contracts.tokens.TST.address,
					ctx.contracts.tokens.TST2.address,
				],
				onResult: (r) => {
					et.equals(r.healthScore, 1.25, 0.001)
				},
			},

			{ action: "revert" },

			// manual liquidation
			{
				action: "sendBatch",
				deferLiquidityCheck: [ctx.wallet.address],
				batch: [
					{
						send: "liquidation.liquidate",
						args: [
							ctx.wallet2.address,
							ctx.contracts.tokens.TST.address,
							ctx.contracts.tokens.TST2.address,
							() => ctx.stash.repay,
							0,
						],
					},
					{
						send: "swap.swapAndRepayUni",
						args: [
							async () => ({
								subAccountIdIn: 0,
								subAccountIdOut: 0,
								amountOut: 0,
								amountInMaximum: et.MaxUint256,
								deadline: 0,
								path: await ctx.encodeUniswapPath(
									["TST2/WETH", "TST/WETH"],
									"TST2",
									"TST",
									true,
								),
							}),
							0,
						],
					},
					{
						send: "markets.exitMarket",
						args: [0, ctx.contracts.tokens.TST.address],
					},
				],
			},

			{
				callStatic: "liquidation.checkLiquidation",
				args: [
					ctx.wallet.address,
					ctx.wallet2.address,
					ctx.contracts.tokens.TST.address,
					ctx.contracts.tokens.TST2.address,
				],
				onResult: (r) => {
					et.equals(r.healthScore, 1.25, 0.001)
				},
			},
		],
	})

	.run()
