/**
 * PayPal -> domain model adapter.
 *
 * Two ingestion paths, deliberately separate because they have different
 * latency characteristics:
 *
 *   1. Transaction Search (`searchTransactions`) builds the HISTORY. It is the
 *      only way to get a two-year behavioural baseline, and the baseline is
 *      what makes "this is 31x their normal rate" meaningful. PayPal documents
 *      a reporting lag of up to three hours, so it can never be the trigger.
 *
 *   2. Webhooks are the TRIGGER. A payment event arrives in real time, is
 *      mapped to a pending transaction, and is assessed against the history
 *      path 1 has already built.
 *
 * Mixing these up is the obvious way to build something that demos fine and
 * cannot work: an assessment that arrives three hours after the money left is
 * not an intervention, it is a receipt.
 */
import type { Account, Payee, Txn, ContextNote } from '../types.ts';

/** Shape of one entry in a Transaction Search response. */
export interface PayPalTransactionDetail {
  transaction_info?: {
    transaction_id?: string;
    transaction_initiation_date?: string;
    transaction_updated_date?: string;
    transaction_amount?: { currency_code?: string; value?: string };
    transaction_status?: string;
    transaction_note?: string;
    transaction_subject?: string;
    payment_method_type?: string;
    custom_field?: string;
  };
  payer_info?: {
    account_id?: string;
    email_address?: string;
    payer_name?: { alternate_full_name?: string; given_name?: string; surname?: string };
  };
  cart_info?: unknown;
}

export interface PayPalSearchResponse {
  transaction_details?: PayPalTransactionDetail[];
  account_number?: string;
  start_date?: string;
  end_date?: string;
  total_items?: number;
  total_pages?: number;
}

function centsFrom(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.abs(n) * 100);
}

/**
 * PayPal reports debits from the account as NEGATIVE values and credits as
 * positive. Direction is read off the sign, not off the transaction type,
 * because the type vocabulary varies by funding source.
 */
function directionFrom(value: string | undefined): 'in' | 'out' {
  const n = Number(value ?? '0');
  return n < 0 ? 'out' : 'in';
}

function instrumentFrom(paymentMethod: string | undefined): Txn['instrument'] {
  switch ((paymentMethod ?? '').toUpperCase()) {
    case 'CREDITCARD':
    case 'DEBITCARD':
      return 'card';
    case 'BANK':
    case 'ACH':
      return 'bank';
    default:
      return 'paypal_balance';
  }
}

function payeeNameFrom(d: PayPalTransactionDetail): string {
  const p = d.payer_info?.payer_name;
  const alt = p?.alternate_full_name?.trim();
  if (alt) return alt;
  const joined = [p?.given_name, p?.surname].filter(Boolean).join(' ').trim();
  if (joined) return joined;
  return d.payer_info?.email_address ?? 'Unknown recipient';
}

/**
 * Stable payee id. PayPal's `account_id` is present for PayPal-to-PayPal
 * movement but absent for many card and guest flows, so email is the fallback
 * and the display name is the last resort. Getting this wrong fragments a
 * single recipient into several, which would silently destroy the escalation
 * and reciprocity signals - they are computed per payee.
 */
export function payeeIdFrom(d: PayPalTransactionDetail): string {
  const acct = d.payer_info?.account_id?.trim();
  if (acct) return 'PP-' + acct;
  const email = d.payer_info?.email_address?.trim().toLowerCase();
  if (email) return 'EM-' + email;
  return 'NM-' + payeeNameFrom(d).toLowerCase().replace(/\s+/g, '-');
}

export interface AdaptOptions {
  personName: string;
  personAgeBand?: string;
  trustedContact?: Account['trustedContact'];
  notes?: ContextNote[];
  /** Payee ids the person has confirmed are genuine, long-standing contacts. */
  establishedPayeeIds?: string[];
}

/**
 * Build an Account from one or more Transaction Search pages.
 *
 * `firstSeenAt` is derived from the earliest transaction observed for each
 * payee in the window supplied. That is a floor, not a truth: a payee whose
 * real history predates the window will look newer than they are. The caller
 * should pass as wide a window as the account allows, and `establishedPayeeIds`
 * exists so a known-good contact is never treated as new.
 */
export function accountFromSearch(
  pages: PayPalSearchResponse[],
  opts: AdaptOptions,
): Account {
  const established = new Set(opts.establishedPayeeIds ?? []);
  const payees = new Map<string, Payee>();
  const transactions: Txn[] = [];

  for (const page of pages) {
    for (const d of page.transaction_details ?? []) {
      const info = d.transaction_info;
      if (!info?.transaction_id || !info.transaction_initiation_date) continue;

      const id = payeeIdFrom(d);
      const ts = info.transaction_initiation_date;
      const existing = payees.get(id);
      if (!existing) {
        payees.set(id, {
          id,
          displayName: payeeNameFrom(d),
          email: d.payer_info?.email_address ?? '',
          firstSeenAt: ts,
          established: established.has(id),
        });
      } else if (ts < existing.firstSeenAt) {
        existing.firstSeenAt = ts;
      }

      const raw = info.transaction_amount?.value;
      transactions.push({
        id: info.transaction_id,
        ts,
        amountCents: centsFrom(raw),
        currency: info.transaction_amount?.currency_code ?? 'USD',
        payeeId: id,
        direction: directionFrom(raw),
        memo: info.transaction_note ?? info.transaction_subject ?? info.custom_field ?? '',
        instrument: instrumentFrom(info.payment_method_type),
        status: (info.transaction_status ?? 'S').toUpperCase() === 'P' ? 'pending' : 'completed',
      });
    }
  }

  transactions.sort((a, b) => a.ts.localeCompare(b.ts));

  return {
    personName: opts.personName,
    personAgeBand: opts.personAgeBand ?? 'unknown',
    accountOpenedAt: transactions[0]?.ts ?? new Date().toISOString(),
    payees: [...payees.values()],
    transactions,
    notes: opts.notes ?? [],
    trustedContact: opts.trustedContact ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Webhook path - the real-time trigger.
 * ------------------------------------------------------------------ */

export interface PayPalWebhookEvent {
  id?: string;
  event_type?: string;
  create_time?: string;
  resource?: {
    id?: string;
    status?: string;
    amount?: { currency_code?: string; value?: string };
    note_to_payee?: string;
    custom_id?: string;
    payee?: { email_address?: string; merchant_id?: string };
    payer?: { email_address?: string; payer_id?: string };
  };
}

/** Event types that represent money about to leave, or having just left. */
export const WATCHED_EVENTS = new Set([
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.COMPLETED',
  'CHECKOUT.ORDER.APPROVED',
  'BILLING.SUBSCRIPTION.CREATED',
]);

/**
 * Map a webhook event onto a pending transaction and attach it to an existing
 * account. Returns a NEW account object; the input is not mutated.
 */
export function applyWebhook(acct: Account, event: PayPalWebhookEvent): Account {
  const r = event.resource;
  if (!r) return acct;

  const email = r.payee?.email_address?.trim().toLowerCase();
  const merchantId = r.payee?.merchant_id?.trim();
  const payeeId = merchantId ? 'PP-' + merchantId : email ? 'EM-' + email : 'NM-unknown';

  const ts = event.create_time ?? new Date().toISOString();
  const payees = [...acct.payees];
  if (!payees.some((p) => p.id === payeeId)) {
    payees.push({
      id: payeeId,
      displayName: email ?? merchantId ?? 'Unknown recipient',
      email: email ?? '',
      firstSeenAt: ts,
      established: false,
    });
  }

  // Only one pending transaction is meaningful at a time; replace any prior one.
  const transactions = acct.transactions.filter((t) => t.status !== 'pending');
  transactions.push({
    id: r.id ?? event.id ?? 'WH-' + Date.now(),
    ts,
    amountCents: centsFrom(r.amount?.value),
    currency: r.amount?.currency_code ?? 'USD',
    payeeId,
    direction: 'out',
    memo: r.note_to_payee ?? r.custom_id ?? '',
    instrument: 'paypal_balance',
    status: 'pending',
  });
  transactions.sort((a, b) => a.ts.localeCompare(b.ts));

  return { ...acct, payees, transactions };
}
