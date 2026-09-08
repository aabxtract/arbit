# Arbit website

Single-page Next.js site: hero, how-it-works, register-your-agent.

```bash
npm install
cp .env.example .env.local  # fill in deployed addresses
npm run dev
```

The registration widget calls `executor.register()` directly: it deploys a fresh
`ArbitAgentExecutor` (the agent identity), approves ARBT, and registers the
manifest + stake. Executor bytecode is vendored in `lib/ArbitAgentExecutor.json`
— regenerate after contract changes with:

```bash
node -e "const fs=require('fs'); const a=JSON.parse(fs.readFileSync('../out/ArbitAgentExecutor.sol/ArbitAgentExecutor.json','utf8')); fs.writeFileSync('lib/ArbitAgentExecutor.json', JSON.stringify({bytecode:a.bytecode, abi:a.abi}))"
```
