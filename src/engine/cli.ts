/**
 * CLI: run the assessment over one fixture, or all of them.
 *
 *   npm run classify -- grandparent
 *   npm run classify -- --all
 *   npm run classify -- --all --offline
 */
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { assess, loadAccount } from './index.ts';
import { SIGNAL_LABEL } from '../scripts/taxonomy.ts';
import type { Assessment, Account } from '../types.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

const TIER_NAME = [
  'silent log',
  'inline note',
  'cooling-off offered',
  'trusted contact notified',
  'co-sign requested',
];

function money(c: number): string {
  return '$' + (c / 100).toLocaleString('en-US');
}

function report(name: string, acct: Account, a: Assessment): void {
  const truth = acct._groundTruth;
  const pending = acct.transactions.find((t) => t.status === 'pending');
  const correct = truth ? truth.script === a.script : null;
  const mark = correct === null ? ' ' : correct ? 'PASS' : 'FAIL';

  console.log('\n' + '='.repeat(74));
  console.log(mark + '  ' + name + '   [engine: ' + a.engine + ']');
  console.log('='.repeat(74));
  if (pending) {
    console.log('  pending   ' + money(pending.amountCents) + ' -> ' + pending.payeeId + '  "' + pending.memo + '"');
  }
  if (truth) {
    console.log('  expected  ' + truth.script + ' stage ' + truth.stage);
  }
  console.log(
    '  got       ' + a.script +
      (a.script === 'none' ? '' : ' stage ' + a.stage + '/' + a.stageCount + ' (' + a.stageName + ')') +
      '   confidence ' + a.confidence.toFixed(2),
  );
  console.log('  tier      ' + a.tier + ' - ' + TIER_NAME[a.tier]);

  if (a.signals.length) {
    console.log('  signals   ' + a.signals.length);
    for (const s of a.signals) {
      console.log('     - ' + SIGNAL_LABEL[s.kind].padEnd(42) + ' ' + s.evidence.slice(0, 110));
    }
  }
  if (a.predictedNextMoves.length) {
    console.log('  predicted next:');
    for (const p of a.predictedNextMoves) {
      console.log('     [' + p.within + ', p=' + p.confidence.toFixed(2) + '] ' + p.description);
    }
  }
  if (a.plainLanguage) {
    console.log('  says to the person:');
    console.log('     ' + a.plainLanguage);
  } else {
    console.log('  says to the person: (nothing)');
  }
  console.log('  uncertainty: ' + a.uncertainty);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const forceOffline = args.includes('--offline');
  const all = args.includes('--all');
  const names = all
    ? readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    : args.filter((a) => !a.startsWith('--'));

  if (!names.length) {
    console.error('usage: npm run classify -- <fixture|--all> [--offline]');
    process.exit(1);
  }

  let pass = 0;
  let fail = 0;
  for (const name of names) {
    const acct = loadAccount(join(FIXTURES, name + '.json'));
    const a = await assess(acct, { forceOffline });
    report(name, acct, a);
    if (acct._groundTruth) {
      if (acct._groundTruth.script === a.script) pass++;
      else fail++;
    }
  }
  console.log('\n' + '-'.repeat(74));
  console.log('script identification: ' + pass + ' pass, ' + fail + ' fail');
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
