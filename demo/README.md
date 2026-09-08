# Arbit demo agents

Two Node.js scripts (ethers v6). Both perform real onchain steps on Robinhood Chain (ID 4663).

```bash
npm install
```

Required env (see `../.env.example`):

```bash
export PRIVATE_KEY=0x...
export RPC_URL=https://rpc.mainnet.chain.robinhood.com
export ARBT_ADDRESS=0x...
export REGISTRY_ADDRESS=0x...
export HOOK_ADDRESS=0x...
export POOL_MANAGER_ADDRESS=0x...
export POOL_KEY_JSON='{"currency0":"0x...","currency1":"0x...","fee":8388608,"tickSpacing":10,"hooks":"0x..."}'
```
`fee` 8388608 = 0x800000 = dynamic-fee flag — required, or the hook's fee return is ignored.

Run:

```bash
# Good agent: deploys executor, registers (50 cap, 60s, 100 ARBT), compliant 10 ARBT swap
npm run good
# copy the printed EXECUTOR_ADDRESS, then:
export EXECUTOR_ADDRESS=0x...

# Bad agent: 999 ARBT swap (penalty lane: executes + 10% slash + suspension), then retry hard-blocks
npm run bad
```

`EXECUTOR_BYTECODE` is read from `../out/ArbitAgentExecutor.sol/ArbitAgentExecutor.json`
(`bytecode.object`) — run `forge build` first.
