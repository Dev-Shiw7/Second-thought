/**
 * Webhook signature verification: the failure paths.
 *
 * Signature verification itself cannot be tested offline - it is a call to
 * PayPal asking PayPal whether PayPal signed something, and there is no
 * offline equivalent. What CAN be tested, and matters more, is what this code
 * does when that call does not come back clean. An endpoint that treats "I
 * could not check" as "it is fine" accepts forged events from anyone, which
 * here would mean fabricating payment events against a real person's account
 * and driving the intervention ladder at will.
 *
 * So every path below answers one question: when verification does not
 * succeed, does anything get through?
 *
 *   npm run verify:failclosed
 */
import { Client } from '@paypal/paypal-server-sdk';
import { verifyWebhook, type WebhookHeaders } from './verify-webhook.ts';
import type { PayPalEnv } from './client.ts';

const ENV: PayPalEnv = { clientId: 'stub-id', clientSecret: 'stub-secret', live: false };

const GOOD_HEADERS: WebhookHeaders = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
  'paypal-transmission-id': 'stub-transmission-id',
  'paypal-transmission-sig': 'stub-signature',
  'paypal-transmission-time': '2026-11-13T00:00:00Z',
};

const EVENT = JSON.stringify({
  id: 'WH-STUB',
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: { amount: { value: '2400.00', currency_code: 'USD' } },
});

/** A client whose token exchange never leaves the process. */
function stubClient(): Client {
  return new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: ENV.clientId,
      oAuthClientSecret: ENV.clientSecret,
    },
    timeout: 5000,
    httpClientOptions: { retryConfig: { maxNumberOfRetries: 0 } },
    unstable_httpClientOptions: {
      adapter: async (config: { url: string }) => ({
        data: JSON.stringify({
          access_token: 'stub-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        status: 200,
        statusText: '',
        headers: { 'content-type': 'application/json' },
        config,
      }),
    },
  });
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
}

/** Replace global fetch for one call, and count whether PayPal was reached. */
async function withStubbedFetch<T>(
  responder: () => Response | Promise<Response> | never,
  run: () => Promise<T>,
): Promise<{ value: T | null; threw: unknown; calls: number }> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return await responder();
  }) as typeof fetch;
  try {
    return { value: await run(), threw: null, calls };
  } catch (err) {
    return { value: null, threw: err, calls };
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function main() {
  // ------------------------------------------------- missing headers
  for (const absent of Object.keys(GOOD_HEADERS) as (keyof WebhookHeaders)[]) {
    const headers = { ...GOOD_HEADERS };
    delete headers[absent];
    const { value, calls } = await withStubbedFetch(
      () => json({ verification_status: 'SUCCESS' }),
      () => verifyWebhook(stubClient(), ENV, headers, EVENT, 'WH-ID'),
    );
    check(
      `rejects a delivery missing ${absent}`,
      value?.verified === false && calls === 0,
      calls === 0 ? 'refused without calling PayPal' : `made ${calls} call(s)`,
    );
  }

  // ------------------------------------------------- unparseable body
  {
    const { value, calls } = await withStubbedFetch(
      () => json({ verification_status: 'SUCCESS' }),
      () => verifyWebhook(stubClient(), ENV, GOOD_HEADERS, '{not json', 'WH-ID'),
    );
    check(
      'rejects a body that is not JSON',
      value?.verified === false && calls === 0,
      value?.verified === false ? value.reason : '',
    );
  }

  // ------------------------------------------------- PayPal says no
  {
    const { value } = await withStubbedFetch(
      () => json({ verification_status: 'FAILURE' }),
      () => verifyWebhook(stubClient(), ENV, GOOD_HEADERS, EVENT, 'WH-ID'),
    );
    check(
      'rejects when PayPal answers FAILURE',
      value?.verified === false,
      value?.verified === false ? value.reason : '',
    );
  }

  // ------------------------------------------- PayPal answers nothing useful
  {
    const { value } = await withStubbedFetch(
      () => json({}),
      () => verifyWebhook(stubClient(), ENV, GOOD_HEADERS, EVENT, 'WH-ID'),
    );
    check(
      'rejects when the answer has no verification_status',
      value?.verified === false,
      value?.verified === false ? value.reason : '',
    );
  }

  // ------------------------------------------------- the verify call 5xxs
  {
    const { value } = await withStubbedFetch(
      () => json({ message: 'upstream exploded' }, 500),
      () => verifyWebhook(stubClient(), ENV, GOOD_HEADERS, EVENT, 'WH-ID'),
    );
    check(
      'rejects when the verify call itself fails',
      value?.verified === false,
      value?.verified === false ? value.reason.slice(0, 60) : '',
    );
  }

  // --------------------------------------------- the network is simply down
  {
    const { value, threw } = await withStubbedFetch(
      () => {
        throw new Error('ECONNREFUSED');
      },
      () => verifyWebhook(stubClient(), ENV, GOOD_HEADERS, EVENT, 'WH-ID'),
    );
    // Either outcome is fail-closed: a thrown error is caught by the caller and
    // answered 503. What must never happen is verified:true.
    check(
      'never reports verified when the network is down',
      value?.verified !== true,
      threw ? 'threw, caller answers 503' : 'returned not-verified',
    );
  }

  // ------------------------------------------------- the one success path
  {
    const { value } = await withStubbedFetch(
      () => json({ verification_status: 'SUCCESS' }),
      () => verifyWebhook(stubClient(), ENV, GOOD_HEADERS, EVENT, 'WH-ID'),
    );
    check('accepts a delivery PayPal confirms', value?.verified === true);
  }

  console.log('\n' + '-'.repeat(70));
  console.log(`fail-closed: ${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
}

void main();
