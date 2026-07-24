/**
 * x402 protocol helpers: probe URLs, extract challenges, replay with payment headers
 */

export interface ProbeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
}

/**
 * Probe a URL to check if it returns a 402 with an x402 challenge
 */
export async function probeUrl(url: string): Promise<ProbeResult> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    redirect: "follow",
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const body = await response.text();

  return {
    status: response.status,
    headers,
    body,
    contentType: headers["content-type"] ?? "",
  };
}

export interface X402Challenge {
  version: string;
  /** The full decoded challenge object (contains x402Version, resource, accepts, extensions) */
  challenge: Record<string, unknown>;
  /** The chosen accepts entry (first one that matches our supported networks) */
  accepted: Record<string, unknown>;
  /** Resource info from the challenge */
  resource: Record<string, unknown>;
}

/**
 * Extract the x402 challenge from a 402 response.
 * Looks in headers (payment-required or x-payment-required) first,
 * then falls back to parsing the response body.
 *
 * Returns the full parsed challenge with the chosen accepts entry.
 */
export function extractChallenge(probe: ProbeResult): X402Challenge {
  let parsed: Record<string, unknown> | null = null;

  // Try headers first — base64 encoded JSON
  const challengeHeader = probe.headers["payment-required"] ?? probe.headers["x-payment-required"];

  if (challengeHeader) {
    try {
      const decoded = Buffer.from(challengeHeader, "base64").toString("utf-8");
      parsed = JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      // If base64 decode fails, try it as raw JSON
      try {
        parsed = JSON.parse(challengeHeader) as Record<string, unknown>;
      } catch {
        // Fall through to body parsing
      }
    }
  }

  // Try body if header didn't work
  if (!parsed) {
    try {
      const bodyParsed = JSON.parse(probe.body) as Record<string, unknown>;
      if (bodyParsed.x402Version || bodyParsed.version || bodyParsed.accepts) {
        parsed = bodyParsed;
      } else if (bodyParsed.challenge) {
        parsed = bodyParsed.challenge as Record<string, unknown>;
      }
    } catch {
      // Can't parse body
    }
  }

  if (!parsed) {
    throw new Error(
      `Could not extract x402 challenge from response. Status: ${probe.status}, Body: ${probe.body.slice(0, 200)}`
    );
  }

  const version = String(parsed.x402Version ?? parsed.version ?? "1");
  const accepts = parsed.accepts as Record<string, unknown>[] | undefined;

  if (!accepts || accepts.length === 0) {
    throw new Error("x402 challenge has no accepts entries");
  }

  // Choose the first accepts entry (could be extended to match network preferences)
  const accepted = accepts[0];
  const resource = (parsed.resource ?? {}) as Record<string, unknown>;

  return { version, challenge: parsed, accepted, resource };
}

/**
 * Build the ProcessPayment payload from the accepted challenge entry.
 * AgentCore expects the accepts object fields (scheme, network, amount, asset, payTo, etc.)
 */
export function buildProcessPaymentPayload(accepted: Record<string, unknown>): Record<string, unknown> {
  return {
    scheme: accepted.scheme,
    network: accepted.network,
    amount: accepted.amount,
    asset: accepted.asset,
    payTo: accepted.payTo,
    maxTimeoutSeconds: accepted.maxTimeoutSeconds,
    extra: accepted.extra,
  };
}

/**
 * Build the x402 v2 PaymentPayload envelope from the signed payment output.
 * This is what goes into the Payment-Signature header (base64 encoded).
 *
 * Per x402 v2 spec, the PaymentPayload structure is:
 * {
 *   x402Version: 2,
 *   resource: { url, description, mimeType },
 *   accepted: { scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra },
 *   payload: { authorization: {...}, signature: "0x..." }
 * }
 */
export function buildPaymentPayloadEnvelope(
  resource: Record<string, unknown>,
  accepted: Record<string, unknown>,
  signedPayload: Record<string, unknown>
): string {
  const envelope = {
    x402Version: 2,
    resource,
    accepted,
    payload: signedPayload,
  };
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

/**
 * Inspect the signed payment output and sleep past validAfter if needed.
 * This prevents EVM clock skew issues where the signature is used before it's valid.
 */
export async function sleepPastValidAfter(signedPayload: Record<string, unknown>): Promise<void> {
  try {
    const authorization = signedPayload.authorization as Record<string, unknown> | undefined;
    if (!authorization) return;

    const validAfter = authorization.validAfter as string | number | undefined;
    if (!validAfter) return;

    const validAfterSec = typeof validAfter === "string" ? parseInt(validAfter, 10) : validAfter;
    const validAfterMs = validAfterSec * 1000;
    const now = Date.now();

    if (validAfterMs > now) {
      const sleepMs = validAfterMs - now + 1000; // +1s buffer
      await new Promise((resolve) => setTimeout(resolve, Math.min(sleepMs, 10000))); // Cap at 10s
    }
  } catch {
    // Non-fatal — skip sleep on any decode error
  }
}

/**
 * Replay a request to the URL with the payment header attached.
 * For x402 v2, uses Payment-Signature header with base64-encoded PaymentPayload.
 */
export async function replayWithHeader(
  url: string,
  headerName: string,
  headerValue: string
): Promise<{ status: number; contentType: string; body: string; url: string }> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      [headerName]: headerValue,
    },
    redirect: "follow",
  });

  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  return {
    status: response.status,
    contentType,
    body,
    url: response.url ?? url,
  };
}
