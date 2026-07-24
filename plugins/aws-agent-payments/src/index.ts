import { Type } from "typebox";
import { loadConfig, setPaymentSessionId, saveFullConfig } from "./config.js";
import {
  getPaymentSessionStatus,
  createPaymentSession,
  processPayment,
  setupPaymentInfrastructure,
} from "./payments.js";
import {
  probeUrl,
  extractChallenge,
  buildProcessPaymentPayload,
  buildPaymentPayloadEnvelope,
  sleepPastValidAfter,
  replayWithHeader,
} from "./x402.js";

function json(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

/**
 * OpenClaw plugin entry point
 */
export function definePluginEntry(api: any) {
  let configLoaded = false;
  async function ensureConfig() {
    if (!configLoaded) {
      await loadConfig(api.pluginConfig);
      configLoaded = true;
    }
  }

  // Tool 1: get_payment_session_status
  api.registerTool({
    name: "get_payment_session_status",
    description:
      "Return current payment session status + a quick usability summary. " +
      "The summary tells the agent whether the session is usable (usable: true) " +
      "or whether create_payment_session should be called instead.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string) {
      await ensureConfig();
      return json(await getPaymentSessionStatus());
    },
  });

  // Tool 2: create_payment_session
  api.registerTool({
    name: "create_payment_session",
    description:
      "Mint a fresh payment session and persist it to the config file. " +
      "Use this when get_payment_session_status reports usable: false. " +
      "The agent should ask the user to approve session creation before calling — " +
      "each session locks USDC up to the spend cap and can't be refunded.",
    parameters: Type.Object({
      max_spend_usd: Type.String({ default: "5", description: "Spend cap for the new session in USD" }),
      expiry_minutes: Type.Number({
        default: 240,
        minimum: 15,
        maximum: 480,
        description: "Session TTL in minutes (15-480)",
      }),
    }),
    async execute(_toolCallId: string, params: { max_spend_usd?: string; expiry_minutes?: number }) {
      await ensureConfig();
      const maxSpend = params.max_spend_usd ?? "5";
      const expiryMin = params.expiry_minutes ?? 240;
      const result = await createPaymentSession(maxSpend, expiryMin);
      await setPaymentSessionId(result.payment_session_id);
      return json(result);
    },
  });

  // Tool 3: get_paid_content
  api.registerTool({
    name: "get_paid_content",
    description:
      "Fetch an x402-paywalled URL, paying for it transparently. " +
      "Probes the URL, and if it returns 402, mints the payment header, " +
      "attaches it, replays the request, and returns the paid response body. " +
      "The agent should call get_payment_session_status first; if the session " +
      "is unusable, ask the user to approve a fresh session via create_payment_session.",
    parameters: Type.Object({
      url: Type.String({ description: "The x402-paywalled URL to fetch and pay for" }),
    }),
    async execute(_toolCallId: string, params: { url: string }) {
      await ensureConfig();
      const url = params.url;

      // Step 1: Probe the URL
      const probe = await probeUrl(url);

      if (probe.status !== 402) {
        return json({
          error:
            `URL did not return 402. Got status ${probe.status}. ` +
            `This tool only handles x402-paywalled URLs.`,
          status_code: probe.status,
        });
      }

      // Step 2: Extract x402 challenge
      const challenge = extractChallenge(probe);

      // Step 3: Build the ProcessPayment payload from the accepted entry
      const processPayload = buildProcessPaymentPayload(challenge.accepted);

      // Step 4: Process payment via AgentCore
      const paymentResult = await processPayment(challenge.version, processPayload);

      // Step 5: Sleep past validAfter if needed
      await sleepPastValidAfter(paymentResult.signedPayload);

      // Step 6: Build the full PaymentPayload envelope and replay
      let headerValue: string;
      let headerName: string;

      if (challenge.version === "2") {
        headerValue = buildPaymentPayloadEnvelope(
          challenge.resource,
          challenge.accepted,
          paymentResult.signedPayload
        );
        headerName = "Payment-Signature";
      } else {
        headerValue = paymentResult.headerValue;
        headerName = "X-PAYMENT";
      }

      const result = await replayWithHeader(url, headerName, headerValue);

      if (result.status === 402) {
        return json({
          error:
            "Payment was processed but the URL still returned 402. " +
            "The payment session may have drained. Check session status and retry.",
          status_code: 402,
        });
      }

      return json({
        status_code: result.status,
        content_type: result.contentType,
        body: result.body,
        url: result.url,
      });
    },
  });

  // Tool 4: pay_and_get_header
  api.registerTool({
    name: "pay_and_get_header",
    description:
      "Mint an x402 payment header for a URL. Returns the header name/value pair " +
      "for the agent to attach via browser_set_extra_http_headers and replay the navigate. " +
      "The agent should call get_payment_session_status first; if the session is unusable, " +
      "ask the user to approve a fresh session via create_payment_session.",
    parameters: Type.Object({
      url: Type.String({ description: "The x402-paywalled URL to generate a payment header for" }),
    }),
    async execute(_toolCallId: string, params: { url: string }) {
      await ensureConfig();
      const url = params.url;

      // Step 1: Probe the URL
      const probe = await probeUrl(url);

      if (probe.status !== 402) {
        return json({
          error:
            `URL did not return 402. Got status ${probe.status}. ` +
            `This tool only handles x402-paywalled URLs.`,
          status_code: probe.status,
        });
      }

      // Step 2: Extract x402 challenge
      const challenge = extractChallenge(probe);

      // Step 3: Build the ProcessPayment payload
      const processPayload = buildProcessPaymentPayload(challenge.accepted);

      // Step 4: Process payment
      const paymentResult = await processPayment(challenge.version, processPayload);

      // Step 5: Sleep past validAfter if needed
      await sleepPastValidAfter(paymentResult.signedPayload);

      // Step 6: Build the header value
      let headerValue: string;
      let headerName: string;

      if (challenge.version === "2") {
        headerValue = buildPaymentPayloadEnvelope(
          challenge.resource,
          challenge.accepted,
          paymentResult.signedPayload
        );
        headerName = "Payment-Signature";
      } else {
        headerValue = paymentResult.headerValue;
        headerName = "X-PAYMENT";
      }

      return json({
        header: { [headerName]: headerValue },
        valid_seconds: 60,
      });
    },
  });

  // Tool 5: setup_x402_payments
  api.registerTool({
    name: "setup_x402_payments",
    description:
      "Set up x402 payment infrastructure from scratch. Creates the Payment Manager, " +
      "Credential Provider, Connector, and Wallet Instrument using AWS AgentCore Payments " +
      "and Coinbase CDP. Requires a Coinbase CDP API key (get from portal.cdp.coinbase.com). " +
      "Call this when the agent detects x402 payments are not configured. " +
      "The user must provide their CDP API key ID, secret, and email.",
    parameters: Type.Object({
      cdp_api_key_id: Type.String({ description: "Coinbase CDP API Key ID (UUID format)" }),
      cdp_api_key_secret: Type.String({ description: "Coinbase CDP API Key Secret (base64 Ed25519 key)" }),
      wallet_secret: Type.String({
        description:
          "Base64-encoded EC P-256 private key for wallet signing",
      }),
      email: Type.String({ description: "Email address for wallet linking" }),
      role_arn: Type.String({
        description:
          "IAM role ARN with bedrock-agentcore.amazonaws.com trust policy. Required to create a payment manager. " +
          "The role must allow bedrock-agentcore service to assume it.",
      }),
      region: Type.Optional(Type.String({ default: "us-east-1", description: "AWS region" })),
      network: Type.Optional(
        Type.String({ default: "eip155:84532", description: "Network preference (default: Base Sepolia testnet)" })
      ),
      user_id: Type.Optional(
        Type.String({ default: "openclaw-user", description: "User ID for the payment manager" })
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        cdp_api_key_id: string;
        cdp_api_key_secret: string;
        wallet_secret: string;
        email: string;
        role_arn: string;
        region?: string;
        network?: string;
        user_id?: string;
      }
    ) {
      try {
        const result = await setupPaymentInfrastructure({
          cdpApiKeyId: params.cdp_api_key_id,
          cdpApiKeySecret: params.cdp_api_key_secret,
          walletSecret: params.wallet_secret,
          email: params.email,
          roleArn: params.role_arn,
          region: params.region,
          network: params.network,
          userId: params.user_id,
        });

        await saveFullConfig({
          region: result.region,
          paymentManagerArn: result.paymentManagerArn,
          paymentInstrumentId: result.instrumentId,
          userId: result.userId,
          networkPreferences: result.networkPreferences,
        });

        return json({
          success: true,
          paymentManagerArn: result.paymentManagerArn,
          instrumentId: result.instrumentId,
          walletAddress: result.walletAddress,
          fundingInstructions: result.fundingInstructions,
          note: "Config saved. Fund the wallet, then x402 payments will work automatically.",
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return json({
          success: false,
          error: errMsg,
          help:
            "Ensure AWS credentials are configured with AgentCore Payments permissions. " +
            "The CDP API key needs wallet creation scope from portal.cdp.coinbase.com.",
        });
      }
    },
  });
}

export default definePluginEntry;
