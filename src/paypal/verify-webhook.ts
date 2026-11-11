/**
 * Webhook signature verification.
 *
 * An unverified webhook endpoint accepts forged events from anyone, which for
 * this project would mean an attacker could fabricate payment events against a
 * real person's account and drive the intervention ladder at will. So this is
 * not optional outside a demo.
 *
 * The PayPal Server SDK exposes Orders, Payments, Subscriptions,
 * TransactionSearch and Vault controllers and no webhooks controller, so
 * `/v1/notifications/verify-webhook-signature` is called directly. The OAuth
 * token still comes from the SDK, so there is exactly one credential path.
 */
import { OAuthAuthorizationController } from '@paypal/paypal-server-sdk';
import type { Client } from '@paypal/paypal-server-sdk';
import type { PayPalEnv } from './client.ts';

const BASE = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

/** The five headers PayPal signs a webhook with. All are required. */
export interface WebhookHeaders {
  'paypal-auth-algo'?: string;
  'paypal-cert-url'?: string;
  'paypal-transmission-id'?: string;
  'paypal-transmission-sig'?: string;
  'paypal-transmission-time'?: string;
}

export type VerifyOutcome =
  | { verified: true }
  | { verified: false; reason: string };

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(client: Client, env: PayPalEnv): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const controller = new OAuthAuthorizationController(client);
  const basic = Buffer.from(env.clientId + ':' + env.clientSecret).toString('base64');
  const res = await controller.requestToken({ authorization: 'Basic ' + basic });

  const token = res.result.accessToken;
  const ttl = typeof res.result.expiresIn === 'number' ? res.result.expiresIn : 300;
  // Expire a minute early so a request never races the boundary.
  cachedToken = { value: token, expiresAt: Date.now() + Math.max(30, ttl - 60) * 1000 };
  return token;
}

/**
 * Verify one webhook delivery.
 *
 * `rawBody` must be the EXACT bytes PayPal sent. Re-serialising a parsed object
 * changes key order and whitespace and the signature will not match - which is
 * why the server captures the raw body before JSON parsing rather than passing
 * `req.body` here.
 */
export async function verifyWebhook(
  client: Client,
  env: PayPalEnv,
  headers: WebhookHeaders,
  rawBody: string,
  webhookId: string,
): Promise<VerifyOutcome> {
  const required: (keyof WebhookHeaders)[] = [
    'paypal-auth-algo',
    'paypal-cert-url',
    'paypal-transmission-id',
    'paypal-transmission-sig',
    'paypal-transmission-time',
  ];
  const missing = required.filter((h) => !headers[h]);
  if (missing.length) {
    return { verified: false, reason: 'missing signature headers: ' + missing.join(', ') };
  }

  let parsedEvent: unknown;
  try {
    parsedEvent = JSON.parse(rawBody);
  } catch {
    return { verified: false, reason: 'body is not valid JSON' };
  }

  const token = await accessToken(client, env);
  const url = (env.live ? BASE.live : BASE.sandbox) + '/v1/notifications/verify-webhook-signature';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      // PayPal requires the event as a JSON value here, not as a string.
      webhook_event: parsedEvent,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return { verified: false, reason: 'verify call failed: HTTP ' + res.status + ' ' + body.slice(0, 200) };
  }

  const out = (await res.json()) as { verification_status?: string };
  return out.verification_status === 'SUCCESS'
    ? { verified: true }
    : { verified: false, reason: 'verification_status=' + (out.verification_status ?? 'unknown') };
}
