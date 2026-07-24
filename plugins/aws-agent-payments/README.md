# Agent Payments (x402)

Enable AI agents to autonomously pay for x402-paywalled APIs, MCP tools, and web content via microtransactions using [AWS AgentCore Payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html).

## Overview

When an AI agent encounters an HTTP 402 (Payment Required) response from an x402-protected endpoint, this plugin transparently handles the payment — probing the challenge, processing payment via AgentCore, and replaying the request with a valid payment header. The agent receives the content without needing to understand the underlying crypto mechanics.

Works with stateful autonomous agents (OpenClaw, custom AgentCore deployments) and AI coding agents that need to access paid APIs or content.

Supports **Coinbase CDP** and **Stripe/Privy** wallet providers on **Base Sepolia** (testnet) and **Base Mainnet** networks.

## Skills

| Skill | When to use | References |
|---|---|---|
| `x402-payments` | "pay for this URL", "x402 paywall", HTTP 402 detected, "set up payments" | protocol, setup, debugging |

## How x402 Payment Works

```
Agent request → HTTP 402 + x402 challenge
    → AgentCore ProcessPayment (signs tx)
    → Replay request with Payment-Signature header
    → HTTP 200 + paid content returned to agent
```

## Installation

### Claude Code

```
/plugin marketplace add aws/agent-toolkit-for-aws
/plugin install aws-agent-payments
```

### Codex

```
codex plugin marketplace add aws/agent-toolkit-for-aws
```

Then launch Codex and install **aws-agent-payments** from the Plugins panel.

### Cursor

Add this repository as a marketplace from **Settings → Plugins → Team Marketplaces → Add Marketplace → Import from Repo**, then install **aws-agent-payments**.

### OpenClaw

```bash
openclaw plugins install clawhub:@aws/aws-agent-payments
```

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "x402-payments": {
        "config": {
          "region": "us-east-1",
          "paymentManagerArn": "arn:aws:bedrock-agentcore:REGION:ACCOUNT_ID:payment-manager/PM_ID",
          "paymentInstrumentId": "YOUR_INSTRUMENT_ID",
          "userId": "your-user-id",
          "networkPreferences": ["eip155:84532"]
        }
      }
    }
  }
}
```

### Other Agents

Install the skill directly:

```bash
npx skills add aws/agent-toolkit-for-aws/plugins/aws-agent-payments/skills
```

Or use the reference implementation in `src/` as a template for your agent's tool system.

## Prerequisites

- AWS account with [AgentCore Payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html) access
- AWS CLI with configured credentials (`aws sts get-caller-identity`)
- IAM role with `bedrock-agentcore.amazonaws.com` trust policy
- Wallet provider account:
  - **Coinbase CDP**: API key from [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com)
  - **Stripe/Privy**: App credentials from [dashboard.privy.io](https://dashboard.privy.io)
- USDC funding on the target network (Base Sepolia for testnet)

## First-Time Setup

If no AgentCore Payments infrastructure exists, the plugin's `setup_x402_payments` tool creates everything in one call:

1. **Payment Manager** — orchestrates payment lifecycle (AWS_IAM authorizer)
2. **Credential Provider** — stores wallet provider keys in AWS Secrets Manager
3. **Payment Connector** — CoinbaseCDP or StripePrivy
4. **Wallet Instrument** — embedded crypto wallet for signing transactions

After setup, authorize delegated signing via the provided redirect URL.

## Tools

| Tool | Description |
|---|---|
| `setup_x402_payments` | One-shot infrastructure setup (creates PM, Connector, Wallet) |
| `get_payment_session_status` | Check current session usability (balance, expiry) |
| `create_payment_session` | Mint a fresh session (locks USDC up to spend cap) |
| `get_paid_content` | Pay + fetch content server-side (recommended path) |
| `pay_and_get_header` | Mint payment header only (for browser-based flows) |

## Security & Spending Controls

- **Session spend caps** — each session locks a maximum USDC amount (default $5)
- **Session TTL** — sessions auto-expire (default 4 hours, max 8 hours)
- **Per-request limits** — AgentCore enforces per-transaction caps from the x402 challenge
- **IAM policies** — scope agent permissions to only `ProcessPayment`, `GetPaymentSession`
- **Audit trail** — all payments logged via CloudTrail

## Supported Networks

| Network | Chain ID | Use Case |
|---|---|---|
| Base Sepolia | `eip155:84532` | Testnet / development |
| Base Mainnet | `eip155:8453` | Production |
| Solana Devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | Testnet (Solana) |
| Solana Mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Production (Solana) |

## Examples

- "Pay for this API endpoint: https://x402-test.example.com/api/weather"
- "Set up x402 payments with my Coinbase CDP credentials"
- "Check my payment session balance"
- "Create a new payment session with $10 cap"
- "This URL returned a 402, can you pay for it?"

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  AI Agent   │────▶│  Agent Payments  │────▶│ AgentCore       │
│ (any host)  │◀────│  Plugin/Skill    │◀────│ Payments API    │
└─────────────┘     └──────────────────┘     └────────┬────────┘
                                                       │
                                              ┌────────▼────────┐
                                              │ Wallet Provider  │
                                              │ (Coinbase/Stripe)│
                                              └────────┬────────┘
                                                       │
                                              ┌────────▼────────┐
                                              │  Base Network    │
                                              │  (on-chain tx)   │
                                              └─────────────────┘
```

## Reference Implementation

The `src/` directory contains a TypeScript reference implementation for stateful agent hosts that support runtime plugins (e.g., OpenClaw). It demonstrates:

- x402 challenge parsing (v1 and v2)
- AgentCore `ProcessPayment` integration
- Payment-Signature envelope construction
- Session lifecycle management
- Full setup automation

Coding agents can use the skill instructions directly. Autonomous agent hosts can adapt the reference implementation to their tool registration patterns.

## License

Apache-2.0
