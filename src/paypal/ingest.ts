/**
 * Live Transaction Search ingestion.
 *
 * PayPal caps each Transaction Search request at a 31-day window, so a
 * meaningful behavioural baseline has to be assembled from many calls. This
 * walks backwards month by month and pages through each window.
 *
 * Error handling here is grounded in the PayPal context plugin's
 * `typescript-error-handling` skill rather than in assumptions, and that
 * changed the code materially — see the notes on RESULTSET_TOO_LARGE below.
 */
import { TransactionSearchController, ApiError, SearchError } from '@paypal/paypal-server-sdk';
import type { Client } from '@paypal/paypal-server-sdk';
import type { PayPalSearchResponse } from './adapter.ts';

/** PayPal rejects windows wider than 31 days on this endpoint. */
const MAX_WINDOW_DAYS = 31;
const PAGE_SIZE = 500;
/** Stop bisecting a too-large window once it gets this small. */
const MIN_WINDOW_DAYS = 1;

function isoDay(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Put the SDK's deserialized model back into PayPal's wire shape.
 *
 * The SDK does not hand back the JSON PayPal sent. It deserializes into its
 * own model, which is camelCase: `transactionDetails`, `totalPages`,
 * `transactionInfo`, `accountId`. Everything downstream of here - the adapter,
 * its round-trip test, and the webhook path, which gets raw unparsed JSON and
 * so really is snake_case - speaks the wire shape.
 *
 * Reading `result` as though it were the wire shape is silent rather than
 * loud: `transaction_details` is undefined, so the page counts as empty;
 * `total_pages` is undefined, so it defaults to 1 and nothing after the first
 * page is ever fetched; and the pages handed on are in a shape the adapter
 * cannot read, so the baseline comes back empty with no error anywhere. That
 * is the exact failure this project keeps warning about - a hole in the
 * baseline does not announce itself, it just makes every ratio wrong.
 *
 * The SDK's naming is a mechanical transform of the wire names, so inverting
 * it mechanically is correct.
 */
function toWireShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWireShape);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())] = toWireShape(v);
  }
  return out;
}

export interface IngestOptions {
  /** How far back to build the baseline. More history means better signals. */
  months?: number;
  /** Stop early once this many transactions are collected. */
  maxTransactions?: number;
  onProgress?: (msg: string) => void;
}

/** The fields PayPal puts in a Transaction Search error body. Wire names. */
interface SearchErrorPayload {
  name?: string;
  message?: string;
  debug_id?: string;
  total_items?: number;
  maximum_items?: number;
}

/**
 * Read a SearchError's payload.
 *
 * `result` is NOT populated here, and assuming it is cost this code its most
 * important branch. The core request builder calls `loadResult` only on the
 * path for errors registered with `throwOn(status, Class)`. `searchTransactions`
 * registers no statuses - it declares `defaultToError(SearchError)` alone - and
 * the default path constructs the error and throws it without parsing anything.
 * So for this operation `err.result` is ALWAYS undefined, however typed the
 * class is, and the payload has to be read off the raw `body`.
 *
 * With `result` trusted, `err.result?.name` was undefined on every error, the
 * RESULTSET_TOO_LARGE test below could never be true, and a window PayPal
 * refused to serve was dropped in silence - which is the exact month-shaped
 * hole in the baseline this whole branch exists to prevent.
 */
function searchErrorPayload(err: SearchError): SearchErrorPayload {
  if (err.result) return err.result as SearchErrorPayload;
  const raw = typeof err.body === 'string' ? err.body : '';
  if (!raw) return {};
  try {
    return JSON.parse(raw) as SearchErrorPayload;
  } catch {
    return {};
  }
}

interface WindowResult {
  pages: PayPalSearchResponse[];
  collected: number;
}

/**
 * Fetch one date window, paging through it.
 *
 * Endpoint methods throw on any non-2xx — there is no non-throwing variant.
 * `searchTransactions` declares no `throwOn` lines at all, only
 * `defaultToError(SearchError)`, so EVERY non-2xx from this operation is a
 * `SearchError`. (The 400/403/500 → `DefaultError` mapping in the same
 * controller belongs to `searchBalances`, a different operation. Reading it as
 * Transaction Search's would mean the RESULTSET_TOO_LARGE branch below never
 * fires.) `SearchError` is a typed subclass, so `result` is populated, and the
 * payload keeps the wire's own field names: `debug_id` and `total_items`,
 * never `debugId` or `totalItems`, unlike the deserialized success models.
 */
async function fetchWindow(
  controller: TransactionSearchController,
  start: Date,
  end: Date,
  remaining: number,
  onProgress?: (msg: string) => void,
): Promise<WindowResult> {
  const label = isoDay(start).slice(0, 10) + '..' + isoDay(end).slice(0, 10);
  const pages: PayPalSearchResponse[] = [];
  let collected = 0;
  let page = 1;
  let totalPages = 1;

  do {
    try {
      const res = await controller.searchTransactions({
        startDate: isoDay(start),
        endDate: isoDay(end),
        // Without this, PayPal returns only transaction_info and the payee is
        // unidentifiable - which collapses every recipient into one bucket.
        fields: 'transaction_info,payer_info',
        pageSize: PAGE_SIZE,
        page,
        balanceAffectingRecordsOnly: 'Y',
      });
      const body = toWireShape(res.result) as PayPalSearchResponse;
      pages.push(body);
      collected += body.transaction_details?.length ?? 0;
      totalPages = body.total_pages ?? 1;
      onProgress?.(
        `${label} page ${page}/${totalPages} (+${body.transaction_details?.length ?? 0})`,
      );
      page++;
    } catch (err) {
      /**
       * RESULTSET_TOO_LARGE is the case worth handling properly. A busy month
       * can exceed what one window will return, and PayPal tells you so,
       * including how many transactions it found. Treating that as a dead
       * window would silently drop an entire month out of the baseline - and
       * because every behavioural signal is measured against that baseline, a
       * hole in it does not announce itself. It just makes the ratios wrong.
       *
       * So: bisect the window and recurse.
       */
      if (err instanceof SearchError) {
        const payload = searchErrorPayload(err);
        const issue = payload.name ?? '';
        const spanDays = (end.getTime() - start.getTime()) / 86400000;
        if (issue === 'RESULTSET_TOO_LARGE' && spanDays > MIN_WINDOW_DAYS) {
          const mid = new Date((start.getTime() + end.getTime()) / 2);
          onProgress?.(
            `${label} too large (${payload.total_items ?? '?'} items, max ` +
              `${payload.maximum_items ?? '?'}) - splitting`,
          );
          const a = await fetchWindow(controller, start, mid, remaining, onProgress);
          const b = await fetchWindow(
            controller,
            mid,
            end,
            remaining - a.collected,
            onProgress,
          );
          return { pages: [...a.pages, ...b.pages], collected: a.collected + b.collected };
        }
      }

      if (err instanceof ApiError) {
        // 404 on this endpoint means "no activity in this window", which is
        // entirely normal across a 24-month walk and is not a failure.
        if (err.statusCode === 404) {
          onProgress?.(`${label} no activity`);
          break;
        }
        // `result` is only populated on the typed subclasses; a bare ApiError
        // never gets that parse, so fall back to the raw body.
        const detail =
          (err instanceof SearchError ? searchErrorPayload(err).message : undefined) ??
          (typeof err.body === 'string' ? err.body.slice(0, 160) : '') ??
          err.message;
        onProgress?.(`${label} HTTP ${err.statusCode}: ${detail}`);
        break;
      }

      onProgress?.(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  } while (page <= totalPages && collected < remaining);

  return { pages, collected };
}

export async function fetchHistory(
  client: Client,
  opts: IngestOptions = {},
): Promise<PayPalSearchResponse[]> {
  const controller = new TransactionSearchController(client);
  const months = opts.months ?? 24;
  const maxTxns = opts.maxTransactions ?? Infinity;
  const pages: PayPalSearchResponse[] = [];
  let collected = 0;

  const now = new Date();
  for (let m = 0; m < months && collected < maxTxns; m++) {
    const end = new Date(now.getTime() - m * MAX_WINDOW_DAYS * 86400000);
    const start = new Date(end.getTime() - MAX_WINDOW_DAYS * 86400000);
    const r = await fetchWindow(controller, start, end, maxTxns - collected, opts.onProgress);
    pages.push(...r.pages);
    collected += r.collected;
  }

  opts.onProgress?.(`done: ${collected} transactions across ${pages.length} pages`);
  return pages;
}
