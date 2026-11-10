/**
 * Live Transaction Search ingestion.
 *
 * PayPal caps each Transaction Search request at a 31-day window, so a
 * meaningful behavioural baseline has to be assembled from many calls. This
 * walks backwards month by month and pages through each window.
 */
import { TransactionSearchController } from '@paypal/paypal-server-sdk';
import type { Client } from '@paypal/paypal-server-sdk';
import type { PayPalSearchResponse } from './adapter.ts';

/** PayPal rejects windows wider than 31 days on this endpoint. */
const MAX_WINDOW_DAYS = 31;
const PAGE_SIZE = 500;

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
        opts.onProgress?.(
          `window ${isoDay(start).slice(0, 10)}..${isoDay(end).slice(0, 10)} page ${page}/${totalPages} (+${body.transaction_details?.length ?? 0})`,
        );
        page++;
      } catch (err) {
        // A window with no activity is a normal 404 from this endpoint, not a
        // failure. Anything else is worth surfacing but not worth aborting a
        // 24-month walk over.
        opts.onProgress?.(
          `window ${isoDay(start).slice(0, 10)} skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }
    } while (page <= totalPages && collected < maxTxns);
  }

  return pages;
}
