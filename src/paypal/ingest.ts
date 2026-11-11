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

export interface IngestOptions {
  /** How far back to build the baseline. More history means better signals. */
  months?: number;
  /** Stop early once this many transactions are collected. */
  maxTransactions?: number;
  onProgress?: (msg: string) => void;
}

interface WindowResult {
  pages: PayPalSearchResponse[];
  collected: number;
}

/**
 * Fetch one date window, paging through it.
 *
 * Endpoint methods throw on any non-2xx — there is no non-throwing variant.
 * Transaction Search maps 400, 403 and 500 to `DefaultError` and everything
 * else to `SearchError`; both are typed subclasses of `ApiError`, so `result`
 * is populated. Note the payload keeps the wire's own field names: it is
 * `debug_id` and `total_items`, never `debugId` or `totalItems`, unlike the
 * camelCase used throughout the rest of the SDK.
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
      const body = res.result as unknown as PayPalSearchResponse;
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
        const issue = err.result?.name ?? '';
        const spanDays = (end.getTime() - start.getTime()) / 86400000;
        if (issue === 'RESULTSET_TOO_LARGE' && spanDays > MIN_WINDOW_DAYS) {
          const mid = new Date((start.getTime() + end.getTime()) / 2);
          onProgress?.(
            `${label} too large (${err.result?.total_items ?? '?'} items, max ` +
              `${err.result?.maximum_items ?? '?'}) - splitting`,
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
          (err as ApiError<{ message?: string; debug_id?: string }>).result?.message ??
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
