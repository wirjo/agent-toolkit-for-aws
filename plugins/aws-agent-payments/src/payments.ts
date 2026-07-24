import {
  BedrockAgentCoreClient,
  GetPaymentSessionCommand,
  CreatePaymentSessionCommand,
  ProcessPaymentCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type {
  PaymentSession,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  BedrockAgentCoreControlClient,
  CreatePaymentManagerCommand,
  CreatePaymentConnectorCommand,
  ListPaymentManagersCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { getConfig } from "./config.js";

let client: BedrockAgentCoreClient | null = null;

function getClient(): BedrockAgentCoreClient {
  if (!client) {
    const config = getConfig();
    client = new BedrockAgentCoreClient({ region: config.region });
  }
  return client;
}

export interface SessionStatus {
  usable: boolean;
  status: string;
  expired: boolean;
  minutes_left: number | null;
  remaining_usd: number | null;
  raw?: unknown;
}

/**
 * Get the current payment session status
 */
export async function getPaymentSessionStatus(): Promise<SessionStatus> {
  const config = getConfig();

  if (!config.payment_session_id) {
    return {
      usable: false,
      status: "no_session",
      expired: true,
      minutes_left: null,
      remaining_usd: null,
    };
  }

  const cmd = new GetPaymentSessionCommand({
    paymentManagerArn: config.paymentManagerArn,
    paymentSessionId: config.payment_session_id,
    userId: config.userId,
  } as any);

  try {
    const response = await getClient().send(cmd);
    const session: PaymentSession | undefined = response.paymentSession;

    if (!session) {
      return {
        usable: false,
        status: "not_found",
        expired: true,
        minutes_left: null,
        remaining_usd: null,
      };
    }

    // Compute expiry from createdAt + expiryTimeInMinutes
    let expired = false;
    let minutesLeft: number | null = null;

    if (session.createdAt && session.expiryTimeInMinutes) {
      const expiryDate = new Date(
        session.createdAt.getTime() + session.expiryTimeInMinutes * 60 * 1000
      );
      const now = new Date();
      expired = expiryDate <= now;
      if (!expired) {
        minutesLeft = Math.round((expiryDate.getTime() - now.getTime()) / 60000);
      }
    }

    // Get remaining balance from availableLimits
    let remainingUsd: number | null = null;
    if (session.availableLimits?.availableSpendAmount?.value) {
      remainingUsd = parseFloat(session.availableLimits.availableSpendAmount.value);
    }

    const usable = !expired;

    return {
      usable,
      status: expired ? "EXPIRED" : "ACTIVE",
      expired,
      minutes_left: minutesLeft,
      remaining_usd: remainingUsd,
      raw: session,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      usable: false,
      status: `error: ${errMsg}`,
      expired: true,
      minutes_left: null,
      remaining_usd: null,
    };
  }
}

export interface CreateSessionResult {
  payment_session_id: string;
  max_spend_usd: string;
  expiry_minutes: number;
}

/**
 * Create a new payment session
 */
export async function createPaymentSession(
  maxSpendUsd: string = "5",
  expiryMinutes: number = 240
): Promise<CreateSessionResult> {
  const config = getConfig();

  const cmd = new CreatePaymentSessionCommand({
    paymentManagerArn: config.paymentManagerArn,
    userId: config.userId,
    limits: {
      maxSpendAmount: {
        value: maxSpendUsd,
        currency: "USD",
      },
    },
    expiryTimeInMinutes: expiryMinutes,
  });

  const response = await getClient().send(cmd);
  const session = response.paymentSession;

  if (!session?.paymentSessionId) {
    throw new Error("CreatePaymentSession did not return a paymentSessionId");
  }

  return {
    payment_session_id: session.paymentSessionId,
    max_spend_usd: maxSpendUsd,
    expiry_minutes: expiryMinutes,
  };
}

export interface PaymentResult {
  headerName: string;
  headerValue: string;
  signedPayload: Record<string, unknown>;
  paymentOutput: unknown;
}

/**
 * Process an x402 payment — send the challenge payload, get back the signed payment.
 *
 * @param version - x402 protocol version ("1" or "2")
 * @param challengePayload - The payment challenge object (accepts entry fields: scheme, network, amount, etc.)
 * @returns The signed payment payload (authorization + signature) and metadata
 */
export async function processPayment(
  version: string,
  challengePayload: Record<string, unknown>
): Promise<PaymentResult> {
  const config = getConfig();

  if (!config.payment_session_id) {
    throw new Error("No active payment session. Create one first.");
  }

  const cmd = new ProcessPaymentCommand({
    paymentManagerArn: config.paymentManagerArn,
    paymentSessionId: config.payment_session_id,
    paymentInstrumentId: config.paymentInstrumentId,
    userId: config.userId,
    paymentType: "CRYPTO_X402",
    paymentInput: {
      cryptoX402: {
        version,
        payload: challengePayload as any,
      },
    },
  });

  const response = await getClient().send(cmd);
  const paymentOutput = response.paymentOutput;

  if (!paymentOutput || !("cryptoX402" in paymentOutput) || !paymentOutput.cryptoX402) {
    throw new Error("ProcessPayment did not return cryptoX402 output");
  }

  const cryptoX402Output = paymentOutput.cryptoX402;
  const signedPayload = cryptoX402Output.payload;

  if (!signedPayload) {
    throw new Error("ProcessPayment cryptoX402 output missing payload (signed payment)");
  }

  // The payload is a DocumentType — normalize to object
  const signedPayloadObj: Record<string, unknown> =
    typeof signedPayload === "string" ? JSON.parse(signedPayload) : signedPayload;

  // For v2: header is Payment-Signature; for v1: X-PAYMENT
  const headerName = version === "2" ? "Payment-Signature" : "X-PAYMENT";

  return {
    headerName,
    headerValue: JSON.stringify(signedPayloadObj), // raw JSON; caller builds envelope
    signedPayload: signedPayloadObj,
    paymentOutput,
  };
}

export interface SetupResult {
  paymentManagerArn: string;
  paymentManagerId: string;
  credentialProviderArn: string;
  connectorId: string;
  instrumentId: string;
  walletAddress?: string;
  region: string;
  userId: string;
  networkPreferences: string[];
  fundingInstructions: string;
}

/**
 * Set up the full x402 payment infrastructure in one call.
 * Creates: Payment Manager → Credential Provider → Connector → Instrument
 */
export async function setupPaymentInfrastructure(params: {
  cdpApiKeyId: string;
  cdpApiKeySecret: string;
  walletSecret: string;
  email: string;
  roleArn: string;
  region?: string;
  network?: string;
  userId?: string;
}): Promise<SetupResult> {
  const region = params.region ?? "us-east-1";
  const network = params.network ?? "eip155:84532";
  const userId = params.userId ?? "openclaw-user";

  const controlClient = new BedrockAgentCoreControlClient({ region });

  // Step 1: Check for existing payment manager or create one
  let paymentManagerArn: string;
  let paymentManagerId: string;

  const listPmResp = await controlClient.send(new ListPaymentManagersCommand({}));
  const existingPms = listPmResp.paymentManagers ?? [];

  if (existingPms.length > 0) {
    paymentManagerArn = existingPms[0].paymentManagerArn!;
    paymentManagerId = existingPms[0].paymentManagerId!;
  } else {
    // Create a new payment manager with the provided role ARN
    const createPmResp = await controlClient.send(
      new CreatePaymentManagerCommand({
        name: "claw-payments",
        authorizerType: "AWS_IAM",
        roleArn: params.roleArn,
      })
    );
    paymentManagerArn = createPmResp.paymentManagerArn!;
    paymentManagerId = createPmResp.paymentManagerId!;
  }

  // Step 2: Create credential provider
  // Note: This requires the control-plane CreatePaymentCredentialProvider API
  // which may need specific permissions
  const credProvResp = await controlClient.send(
    new (await import("@aws-sdk/client-bedrock-agentcore-control")).CreatePaymentCredentialProviderCommand({
      name: `cdp_${Date.now()}`,
      credentialProviderVendor: "CoinbaseCDP",
      providerConfigurationInput: {
        coinbaseCdpConfiguration: {
          apiKeyId: params.cdpApiKeyId,
          apiKeySecret: params.cdpApiKeySecret,
          apiKeySecretSource: "MANAGED",
          walletSecret: params.walletSecret,
          walletSecretSource: "MANAGED",
        },
      },
    })
  );
  const credentialProviderArn = credProvResp.credentialProviderArn!;

  // Step 3: Create connector
  const connResp = await controlClient.send(
    new CreatePaymentConnectorCommand({
      paymentManagerId,
      name: `cdpConnector${Date.now()}`,
      type: "CoinbaseCDP",
      credentialProviderConfigurations: [
        { coinbaseCDP: { credentialProviderArn } },
      ],
    })
  );
  const connectorId = connResp.paymentConnectorId!;

  // Step 4: Create instrument
  const dataClient = new BedrockAgentCoreClient({ region });
  const { CreatePaymentInstrumentCommand } = await import("@aws-sdk/client-bedrock-agentcore");
  const instrResp = await dataClient.send(
    new CreatePaymentInstrumentCommand({
      paymentManagerArn,
      paymentConnectorId: connectorId,
      paymentInstrumentType: "EMBEDDED_CRYPTO_WALLET",
      paymentInstrumentDetails: {
        embeddedCryptoWallet: {
          network: "ETHEREUM",
          linkedAccounts: [{ email: { emailAddress: params.email } }],
        },
      },
      userId,
    })
  );

  const instrumentId = instrResp.paymentInstrument?.paymentInstrumentId ?? instrResp.paymentInstrument?.paymentInstrumentId!;
  const walletDetails = (instrResp.paymentInstrument as any)?.paymentInstrumentDetails?.embeddedCryptoWallet;
  const walletAddress = walletDetails?.walletAddress ?? walletDetails?.address;

  const fundingInstructions = network === "eip155:84532"
    ? `Fund with Base Sepolia USDC at https://faucet.circle.com/ (pick Base Sepolia). Send to: ${walletAddress ?? instrumentId}`
    : `Fund the wallet with USDC on the configured network. Address: ${walletAddress ?? instrumentId}`;

  return {
    paymentManagerArn,
    paymentManagerId,
    credentialProviderArn,
    connectorId,
    instrumentId,
    walletAddress,
    region,
    userId,
    networkPreferences: [network],
    fundingInstructions,
  };
}
