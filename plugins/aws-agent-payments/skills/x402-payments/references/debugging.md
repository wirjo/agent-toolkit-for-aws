# Debugging Reference

## Common Issues

### "PaymentSessionExpired" or "ExpiredTokenException"

**Cause:** Session TTL exceeded or session was never created.

**Fix:**
1. Call `get_payment_session_status` to confirm
2. Ask user to approve a new session
3. Call `create_payment_session` with desired cap/TTL

### "Still 402 after payment"

**Cause:** The payment was processed but the merchant's on-chain settlement is transient — the signature hasn't propagated yet.

**Fix:**
- The tool automatically retries. If it persists:
  - Check if session balance is zero (drained between check and pay)
  - Try again with a fresh session
  - Verify wallet has sufficient USDC on the correct network

### "InvalidSignature" or signing failures

**Cause:** Wallet instrument or connector misconfigured.

**Fix:**
1. Verify delegated signing was authorized (the redirect URL step)
2. Check that the wallet secret matches what was provided during setup
3. Confirm the connector type matches the credential provider

### "NetworkMismatch"

**Cause:** The x402 endpoint expects a different network than configured.

**Fix:**
- Check the endpoint's `accepts` array for required network
- Update `networkPreferences` in plugin config to include the required network
- Ensure wallet is funded on that network

### "AccessDeniedException" on ProcessPayment

**Cause:** IAM permissions insufficient.

**Fix:**
- Verify the calling identity has `bedrock-agentcore:ProcessPayment` permission
- Check the resource ARN matches the Payment Manager
- Verify the region matches

### Setup tool fails with "CredentialProviderAlreadyExists"

**Cause:** A credential provider with that name already exists.

**Fix:**
- The setup tool auto-generates unique names with random suffixes
- If it collides, delete the old one via AWS console or CLI:
  ```bash
  aws bedrock-agentcore-control delete-credential-provider \
    --payment-manager-id PM_ID \
    --credential-provider-id CP_ID \
    --region REGION
  ```

## Diagnostic Steps

1. **Check session:** `get_payment_session_status` → look at `status`, `remainingBalance`, `expiresAt`
2. **Check wallet funding:** Verify USDC balance on block explorer for the wallet address
3. **Check AWS credentials:** `aws sts get-caller-identity` → confirm correct account/role
4. **Check region:** Ensure Payment Manager region matches the config
5. **Check network:** Confirm endpoint's required network is in `networkPreferences`

## Logs

- **CloudTrail:** All AgentCore API calls logged (ProcessPayment, CreatePaymentSession, etc.)
- **Agent host logs:** Check for HTTP 402 response bodies — they contain the x402 challenge details
