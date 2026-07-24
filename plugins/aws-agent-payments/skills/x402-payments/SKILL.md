---
name: x402-payments
description: >-
  Auto-pay x402-paywalled URLs transparently using AWS AgentCore Payments.
  Triggers on HTTP 402 responses, processes payment via AgentCore, and retries
  with a valid payment header. Supports Coinbase CDP and Stripe/Privy wallets.
  Works with any agent host that provides HTTP tool capabilities.
version: 1.0.0
metadata:
  tags: [x402, payments, paywall, usdc, crypto, web3, agentcore, micropayments]
---

# x402 Payments

This skill enables AI agents to auto-pay x402-paywalled URLs using AWS AgentCore Payments. It is agent-host independent — it describes the protocol and tool interactions generically, working the same whether tools are exposed as direct functions, MCP tools, or namespaced actions.

## Tool Inventory

The x402 payment system provides five tools. Match them by role — your runtime may prefix or rename them:

| Role | Typical name | Purpose |
|---|---|---|
| Infrastructure setup | `setup_x402_payments` | One-shot creation of Payment Manager, Connector, Wallet |
| Session status check | `get_payment_session_status` | Check if current session is usable |
| Session creation | `create_payment_session` | Mint a fresh session (locks USDC) |
| Server-side pay + fetch | `get_paid_content` | Pay and return content in one call |
| Header-only payment | `pay_and_get_header` | Mint payment header for browser replay |

## When to Use

Activate this skill when **any** of these occur:

- An HTTP request returns 402 with x402 challenge headers (`x402Version`, `Payment-Required`, or `x-payment-required`)
- The user asks to access content from a URL they identify as x402-paywalled
- The user asks to "set up x402 payments" or "configure agent payments"
- A tool call fails with 402 Payment Required

Do NOT use for:
- Login walls, captchas, or non-x402 paywalls
- AWS billing or cost management
- Stripe checkout / e-commerce payments

## Protocol

### Step 1: Check Payment Session

Call the **session-status** tool. The response includes a `usable` boolean.

- **If `usable: true`** → proceed to Step 3
- **If `usable: false`** → the session is expired, drained, or doesn't exist. Go to Step 2.

### Step 2: Request User Approval for New Session

**Never mint a session without explicit user approval.** Each session locks USDC up to its spend cap.

Tell the user:
> Your payment session is [expired/drained/missing]. I can create a new one with a $5 cap valid for 4 hours. Approve?

On approval, call the **create-session** tool with `max_spend_usd="5"` and `expiry_minutes=240` (or user-specified values).

### Step 3: Pay for the URL

**Preferred path (server-side):** Call `get_paid_content` with the URL. The tool:
1. Probes the URL → gets 402 + x402 challenge
2. Calls AgentCore ProcessPayment → gets signed payment header
3. Replays the request with the payment header
4. Returns `{status_code, content_type, body, url}`

Read the content from the `body` field. No second request needed.

**Alternative path (browser/header-only):** If you need the page rendered in a live browser:
1. Call `pay_and_get_header` → returns `{header: {"Payment-Signature": "VALUE"}, valid_seconds: 60}`
2. Set the header on your browser context
3. Navigate to the URL again
4. The paid page renders normally

### Step 4: Handle Errors

- **Session expired mid-request** → go back to Step 2
- **Still 402 after payment** → session may have drained, mint a new one
- **Header expired** (>60s elapsed) → call `pay_and_get_header` again

## First-Time Setup

If no payment infrastructure exists, use the **setup** tool with:

- `role_arn` — IAM role with `bedrock-agentcore.amazonaws.com` trust policy
- `cdp_api_key_id` + `cdp_api_key_secret` + `wallet_secret` + `email` (for Coinbase)
- Optional: `region` (default us-east-1), `network` (default eip155:84532), `user_id`

After setup:
1. Provide the redirect URL for delegated signing authorization
2. Instruct the user to fund the wallet with USDC on the target network

## Guidelines

- **Don't surface payment internals** — report the content, not transaction hashes or header bytes
- **Always check session status first** — avoids `ExpiredTokenException` errors
- **Never auto-mint sessions** — get explicit user approval each time (unless user previously authorized auto-creation)
- **Payment headers expire in ~60 seconds** — if using the header path, replay immediately
- **Idempotent retries** — ProcessPayment uses a client_token for idempotency, safe to retry on transient failures

## Verification

The skill succeeded if the agent:
1. Detected the 402
2. Paid transparently
3. Returned the paid content to the user

The user should never see "Payment Required" as a final error.
