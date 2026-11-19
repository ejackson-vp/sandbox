# throwbox MCP server

An MCP server that buys a disposable Linux box for one command. The client that
launches it holds the wallet; the model sees stdout, stderr and an exit code.

Two tools:

| Tool | What it does | Cost |
| --- | --- | --- |
| `pricing` | Reads the live tier table from the service. | free |
| `run` | Creates a session, writes any files, runs `/bin/sh -lc <command>`, returns the output, destroys the box. | one session |

There is no tool that keeps a session alive. The lease is the product: the box
and its `/workspace` are gone when the call returns.

## Configure

The wallet must hold a small amount of USDC on Base. Use a wallet you are
willing to spend from, not your main one.

```bash
npm install -g throwbox-mcp
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "throwbox": {
      "command": "throwbox-mcp",
      "env": {
        "EVM_PRIVATE_KEY": "0x...",
        "CONFIRM_REAL_MONEY": "yes",
        "THROWBOX_TIER": "short"
      }
    }
  }
}
```

Cursor, Cline and anything else that speaks MCP take the same block. From a
checkout instead of npm:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/sandbox/mcp/dist/index.js"]
}
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | none | The paying wallet. Required for testnet and mainnet. |
| `CONFIRM_REAL_MONEY` | unset | Must be `yes`. Without it the server refuses mainnet. |
| `PAYMENT_MODE` | `mainnet` | `mainnet`, `testnet` or `mock`. |
| `THROWBOX_API_URL` | `https://api.throwbox.dev` | Which service to buy from. |
| `THROWBOX_TIER` | `short` | Default tier: 60 s, $0.02. |
| `THROWBOX_MAX_COMMAND_SECONDS` | `300` | Ceiling on the per-call timeout. |

The server exits at launch rather than failing at the first paid call, so a
missing key shows up as a dead tool in the client's log, with the variable that
is missing.

## What it costs

`short` is 60 seconds of one Linux machine for $0.02, `standard` is five
minutes for $0.05. Prices come from the service, not from this file; ask
`pricing`.

## Why this exists

A sandbox is the thing an agent needs most and can buy least: every other
provider wants an account and a card before it will run a line of code. The
payment header is the account here, so an agent with a wallet can buy a machine
by itself.
