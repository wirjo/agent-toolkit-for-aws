# x402 Protocol Reference

## How x402 Works

x402 is a standard HTTP payment protocol that extends HTTP 402 (Payment Required) with machine-readable payment challenges. When a server protects content behind a paywall:

1. Client makes a normal HTTP request
2. Server returns HTTP 402 with payment challenge headers
3. Client processes payment (signs a blockchain transaction)
4. Client replays the request with a payment proof header
5. Server verifies the proof and returns the content

## x402 Versions

### Version 1 (Legacy)

- Challenge: `X-PAYMENT-REQUIRED` header with JSON payload
- Payment header: `X-PAYMENT` with signed proof
- Single accepted payment scheme per challenge

### Version 2 (Current)

- Challenge: `Payment-Required` header OR JSON body with `x402Version: "2"`
- Payment header: `Payment-Signature` with base64-encoded PaymentPayload envelope
- Multiple accepted payment schemes per challenge
- Structured `accepts` array with scheme, network, amount, asset, payTo, maxTimeoutSeconds

## PaymentPayload Envelope (v2)

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "eip155:84532",
  "payload": {
    "signature": "<from ProcessPayment>",
    "authorization": "<from ProcessPayment>",
    "token": "<asset address>",
    "transferAmount": "<amount in base units>",
    "nonce": "<unique nonce>",
    "recipient": "<payTo address>",
    "validAfter": "<timestamp>",
    "validBefore": "<timestamp>"
  },
  "resource": "<original request URL>"
}
```

## AgentCore ProcessPayment

The AgentCore Payments API handles the cryptographic signing:

**Input:**
- Payment Manager ARN
- Instrument ID
- Session ID
- User ID
- Payment challenge (accepts[0] object from x402 challenge)

**Output:**
- Signed payload (authorization + signature)
- Header value (for v1)
- Transaction metadata

## Supported Asset Addresses

| Network | Asset | Address |
|---|---|---|
| Base Sepolia | USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Base Mainnet | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Error Codes

| Error | Meaning | Resolution |
|---|---|---|
| `PaymentSessionExpired` | Session TTL exceeded | Create new session |
| `InsufficientBalance` | Session spend cap reached | Create new session with higher cap |
| `InvalidSignature` | Wallet signing failed | Check instrument/connector setup |
| `NetworkMismatch` | Wrong network for endpoint | Update networkPreferences |
