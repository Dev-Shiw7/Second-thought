/**
 * Adapter round-trip verification.
 *
 * Renders each fixture into the exact shape PayPal's Transaction Search
 * returns, reads it back through the production adapter, and asserts the
 * assessment is unchanged.
 *
 * The point is to prove the PayPal mapping is faithful without needing
 * credentials - a reviewer can run this on a clean checkout. It catches the
 * failure that would otherwise be invisible until demo day: payee identity
 * fragmenting across transactions, which silently destroys the escalation and
 * reciprocity signals because both are computed per payee.
 *
 *   npm run verify:paypal
 */
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccount, assess } from '../engine/index.ts';
import { accountFromSearch, type PayPalSearchResponse, type PayPalTransactionDetail } from './adapter.ts';
import type { Account } from '../types.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

/** Render our domain model back out into PayPal's wire shape. */
function toPayPalPages(acct: Account): PayPalSearchResponse[] {
  const details: PayPalTransactionDetail[] = acct.transactions.map((t) => {
    const payee = acct.payees.find((p) => p.id === t.payeeId);
    const signed = (t.direction === 'out' ? -1 : 1) * (t.amountCents / 100);
    return {
      transaction_info: {
        transaction_id: t.id,
        transaction_initiation_date: t.ts,
        transaction_amount: { currency_code: t.currency, value: signed.toFixed(2) },
        transaction_status: t.status === 'pending' ? 'P' : 'S',
        transaction_note: t.memo,
        payment_method_type:
          t.instrument === 'card' ? 'CREDITCARD' : t.instrument === 'bank' ? 'BANK' : 'PAYPAL',
      },
      payer_info: {
        // Deliberately exercise the fallback chain: half the payees carry no
        // account_id, which is realistic for card and guest flows.
        account_id: payee && payee.id.startsWith('P-') && payee.established ? payee.id : undefined,
        email_address: payee?.email,
        payer_name: { alternate_full_name: payee?.displayName },
      },
    };
  });

  // Split across several pages to exercise multi-page assembly.
  const pages: PayPalSearchResponse[] = [];
  const size = 120;
  for (let i = 0; i < details.length; i += size) {
    pages.push({
      transaction_details: details.slice(i, i + size),
      total_pages: Math.ceil(details.length / size),
      total_items: details.length,
    });
  }
  return pages;
}

async function main(): Promise<void> {
  const names = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

  let pass = 0;
  let fail = 0;

  for (const name of names) {
    const original = loadAccount(join(FIXTURES, name + '.json'));

    const pages = toPayPalPages(original);
    const rebuilt = accountFromSearch(pages, {
      personName: original.personName,
      personAgeBand: original.personAgeBand,
      trustedContact: original.trustedContact,
      // Notes are NOT PayPal data - they come from the companion app and the
      // person's own memos, and are carried alongside.
      notes: original.notes,
      establishedPayeeIds: original.payees.filter((p) => p.established).map((p) => p.id),
    });

    const before = await assess(original, { forceOffline: true });
    const after = await assess(rebuilt, { forceOffline: true });

    const txnOk = rebuilt.transactions.length === original.transactions.length;
    const payeeOk = rebuilt.payees.length === original.payees.length;
    const scriptOk = before.script === after.script;
    const stageOk = before.stage === after.stage;
    const ok = txnOk && payeeOk && scriptOk && stageOk;

    console.log(
      (ok ? 'PASS  ' : 'FAIL  ') +
        name.padEnd(20) +
        ' txns ' + original.transactions.length + '->' + rebuilt.transactions.length +
        '  payees ' + original.payees.length + '->' + rebuilt.payees.length +
        '  ' + before.script + ':' + before.stage + ' -> ' + after.script + ':' + after.stage,
    );
    if (!ok) {
      if (!txnOk) console.log('        transaction count changed through the adapter');
      if (!payeeOk) console.log('        payee identity fragmented or merged');
      if (!scriptOk || !stageOk) console.log('        assessment changed through the adapter');
      fail++;
    } else {
      pass++;
    }
  }

  console.log('\n' + '-'.repeat(70));
  console.log('adapter round-trip: ' + pass + ' pass, ' + fail + ' fail');
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
