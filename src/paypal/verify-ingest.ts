/**
 * Ingestion verification, with no PayPal account.
 *
 * `verify-adapter.ts` proves the mapping from PayPal's wire shape into our
 * model. It does not touch `ingest.ts`, which is where the harder logic lives:
 * a 24-month baseline assembled from 31-day windows, paged, with a bisect when
 * PayPal says a window returned more than it will serve. That logic was
 * completely untested, and it is the code most likely to fail against real
 * data - a live sandbox with an empty transaction history would not have
 * exercised one line of it either.
 *
 * The seam is the one the SDK actually documents for this: a stub axios
 * adapter passed through `unstable_httpClientOptions`. No network, no ports,
 * no global patching. Two details that are easy to get wrong and fail
 * confusingly:
 *
 *   - The SDK disables axios response transformation, so the adapter must hand
 *     back the serialized body as a STRING, exactly as the wire would.
 *   - Transaction Search authenticates with OAuth, and the token exchange goes
 *     through this same adapter. Seeding an unexpired token means only the
 *     calls under test arrive, so request counts mean what they look like.
 *
 *   npm run verify:ingest
 */
import { Client, SearchError, ApiError } from '@paypal/paypal-server-sdk';
import { fetchHistory } from './ingest.ts';

interface Captured {
  url: string;
  startDate: string;
  endDate: string;
  page: number;
  spanDays: number;
}

type Responder = (req: Captured, n: number) => { status: number; body: unknown };

/** A client whose transport is a function, not a socket. */
function stubClient(respond: Responder): { client: Client; seen: () => Captured[] } {
  const seen: Captured[] = [];

  const client = new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: 'stub-id',
      oAuthClientSecret: 'stub-secret',
      // Unexpired, so the manager never fetches and the adapter only ever sees
      // the search calls themselves.
      oAuthToken: {
        accessToken: 'stub-token',
        tokenType: 'Bearer',
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      },
    },
    timeout: 5000,
    // A stubbed 5xx should fail on the first attempt rather than wait out backoff.
    httpClientOptions: { retryConfig: { maxNumberOfRetries: 0 } },
    unstable_httpClientOptions: {
      adapter: async (config: { url: string; method: string }) => {
        const url = new URL(config.url);
        const startDate = url.searchParams.get('start_date') ?? '';
        const endDate = url.searchParams.get('end_date') ?? '';
        const req: Captured = {
          url: config.url,
          startDate,
          endDate,
          page: Number(url.searchParams.get('page') ?? '1'),
          spanDays:
            (Date.parse(endDate) - Date.parse(startDate)) / 86400000,
        };
        seen.push(req);
        const { status, body } = respond(req, seen.length);
        return {
          data: typeof body === 'string' ? body : JSON.stringify(body),
          status,
          statusText: '',
          headers: { 'content-type': 'application/json' },
          config,
        };
      },
    },
  });

  return { client, seen: () => seen };
}

function page(n: number, totalPages: number, count: number) {
  return {
    transaction_details: Array.from({ length: count }, (_, i) => ({
      transaction_info: {
        transaction_id: `T-${n}-${i}`,
        transaction_initiation_date: '2026-01-15T00:00:00Z',
        transaction_amount: { currency_code: 'USD', value: '-10.00' },
        transaction_status: 'S',
      },
      payer_info: { account_id: 'P-STUB', payer_name: { alternate_full_name: 'Stub Payee' } },
    })),
    page: n,
    total_items: count * totalPages,
    total_pages: totalPages,
  };
}

const tooLarge = {
  name: 'RESULTSET_TOO_LARGE',
  message: 'Result set size is greater than the maximum limit.',
  debug_id: 'stub-debug-id',
  total_items: 12000,
  maximum_items: 10000,
};

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

async function main() {
  // ---------------------------------------------------------------- windows
  {
    const { client, seen } = stubClient(() => ({ status: 200, body: page(1, 1, 3) }));
    await fetchHistory(client, { months: 4 });
    const reqs = seen();
    const widest = Math.max(...reqs.map((r) => r.spanDays));
    check(
      'never requests a window wider than PayPal allows',
      widest <= 31,
      `widest window ${widest.toFixed(1)} days across ${reqs.length} calls`,
    );

    const starts = reqs.map((r) => Date.parse(r.startDate));
    const walksBackwards = starts.every((s, i) => i === 0 || s < starts[i - 1]!);
    check('walks backwards month by month', walksBackwards, `${reqs.length} windows`);

    // 4 months requested, one page each.
    check('one window per month when nothing pages', reqs.length === 4, `${reqs.length} calls`);
  }

  // ---------------------------------------------------------------- paging
  {
    const { client, seen } = stubClient((req) => ({
      status: 200,
      body: page(req.page, 3, 500),
    }));
    const pages = await fetchHistory(client, { months: 1 });
    const requested = seen().map((r) => r.page);
    check(
      'pages through a multi-page window',
      pages.length === 3 && requested.join(',') === '1,2,3',
      `pages requested ${requested.join(',')}`,
    );
  }

  // ------------------------------------------------------- maxTransactions
  {
    const { client } = stubClient((req) => ({ status: 200, body: page(req.page, 10, 500) }));
    const pages = await fetchHistory(client, { months: 24, maxTransactions: 600 });
    const total = pages.reduce((a, p) => a + (p.transaction_details?.length ?? 0), 0);
    check(
      'stops once maxTransactions is satisfied',
      total >= 600 && pages.length <= 3,
      `${total} transactions in ${pages.length} pages`,
    );
  }

  // ------------------------------------------------------ RESULTSET_TOO_LARGE
  {
    // The first window is too large; its halves are fine. This is the case that
    // would otherwise drop a whole month out of the baseline in silence.
    const { client, seen } = stubClient((req, n) => {
      if (n === 1) return { status: 400, body: tooLarge };
      return { status: 200, body: page(req.page, 1, 7) };
    });
    const pages = await fetchHistory(client, { months: 1 });
    const reqs = seen();
    const halves = reqs.slice(1);
    const spans = halves.map((r) => r.spanDays);
    const bisected =
      halves.length === 2 && spans.every((s) => s > 14 && s < 17);
    check(
      'bisects a window PayPal says is too large',
      bisected,
      `halves ${spans.map((s) => s.toFixed(1)).join(' + ')} days`,
    );
    check(
      'keeps the data from both halves rather than dropping the month',
      pages.length === 2 &&
        pages.reduce((a, p) => a + (p.transaction_details?.length ?? 0), 0) === 14,
      `${pages.length} pages recovered`,
    );

    // Contiguity matters: a gap here is a hole in the baseline that nothing reports.
    const gap = Math.abs(Date.parse(halves[1]!.startDate) - Date.parse(halves[0]!.endDate));
    check('the two halves meet with no gap', gap === 0, `gap ${gap}ms`);
  }

  // --------------------------------------------------- bisect has a floor
  {
    // Every window is too large, forever. Without the MIN_WINDOW_DAYS floor
    // this recurses until the stack dies.
    const { client, seen } = stubClient(() => ({ status: 400, body: tooLarge }));
    let threw = false;
    try {
      await fetchHistory(client, { months: 1 });
    } catch {
      threw = true;
    }
    check(
      'stops bisecting instead of recursing forever',
      !threw && seen().length < 200,
      `${seen().length} calls before giving up`,
    );
  }

  // ------------------------------------------------------------------- 404
  {
    const { client } = stubClient((_req, n) =>
      n === 1
        ? { status: 404, body: { name: 'INVALID_REQUEST', message: 'no activity', debug_id: 'x' } }
        : { status: 200, body: page(1, 1, 2) },
    );
    const pages = await fetchHistory(client, { months: 3 });
    check(
      'treats 404 as an empty window, not a failure',
      pages.length === 2,
      `${pages.length} pages from the 2 windows that had activity`,
    );
  }

  // -------------------------------------------------- which error class fires
  {
    // Pins the real mapping. searchTransactions declares NO throwOn lines - only
    // `defaultToError(SearchError)` - so every non-2xx from this operation is a
    // SearchError. The 400/403/500 -> DefaultError mapping belongs to
    // searchBalances, a different operation in the same controller. Getting this
    // backwards means the RESULTSET_TOO_LARGE branch never fires.
    const { client } = stubClient(() => ({ status: 400, body: tooLarge }));
    const { TransactionSearchController } = await import('@paypal/paypal-server-sdk');
    const controller = new TransactionSearchController(client);
    let caught: unknown;
    try {
      await controller.searchTransactions({
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-01-31T00:00:00Z',
      });
    } catch (err) {
      caught = err;
    }
    check(
      'a 400 from searchTransactions is a SearchError',
      caught instanceof SearchError,
      caught instanceof ApiError ? caught.constructor.name : String(caught),
    );
    // `result` is populated only for errors registered with throwOn(status, Class);
    // searchTransactions registers none, so the typed class arrives with result
    // undefined and the payload has to come off the raw body. Pinning both halves
    // of that, because trusting `result` silently disabled the bisect above.
    check(
      'a typed SearchError still arrives with result undefined',
      caught instanceof SearchError && caught.result === undefined,
      caught instanceof SearchError ? `result=${String(caught.result)}` : '',
    );
    const body =
      caught instanceof SearchError && typeof caught.body === 'string'
        ? (JSON.parse(caught.body) as Record<string, unknown>)
        : {};
    check(
      'the payload is on body, and keeps PayPal wire names',
      body.total_items === 12000 && body.name === 'RESULTSET_TOO_LARGE',
      `total_items=${String(body.total_items)}`,
    );
  }

  // ------------------------------------------------ SDK -> ingest -> adapter
  {
    // The seam that hid the bug. verify-adapter.ts feeds the adapter
    // wire-shaped fixtures directly, so it never saw that the SDK hands back
    // its own camelCase model rather than PayPal's JSON. Nothing downstream
    // errored on that - the account simply came out empty. Running the whole
    // chain is the only arrangement that catches it.
    const { client } = stubClient((req) => ({ status: 200, body: page(req.page, 1, 4) }));
    const pages = await fetchHistory(client, { months: 1 });
    const { accountFromSearch } = await import('./adapter.ts');
    const acct = accountFromSearch(pages, { personName: 'Stub Person' });
    check(
      'a page fetched through the SDK survives into an Account',
      acct.transactions.length === 4 && acct.payees.length === 1,
      `${acct.transactions.length} transactions, ${acct.payees.length} payee(s)`,
    );
    check(
      'payee identity survives the SDK round trip',
      acct.payees[0]?.displayName === 'Stub Payee',
      `payee "${acct.payees[0]?.displayName ?? '(none)'}"`,
    );
  }

  console.log('\n' + '-'.repeat(70));
  console.log(`ingestion: ${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
}

void main();
