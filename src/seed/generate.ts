/**
 * Deterministic fixture generator.
 *
 * The seed data is the demo. It is written first and deliberately, because a
 * classifier is only as convincing as the histories it runs against.
 *
 * Six scenarios, including two controls. The controls matter more than they
 * look: `clean` shows the system is quiet during an ordinary month, and
 * `legit_large` is a payment that is numerically alarming (large, round, brand
 * new payee) but narratively innocent. Any amount-based system flags it. Ours
 * must not — that contrast is the clearest evidence that we are reading the
 * story rather than the number.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account, Payee, Txn, ContextNote } from '../types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../fixtures');

/** mulberry32 — tiny deterministic PRNG so fixtures are reproducible. */
function rng(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = new Date('2026-11-11T09:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86400000);
const iso = (d: Date) => d.toISOString();
const dayIso = (n: number) => iso(day(n));

let seq = 0;
const tid = () => `TXN${String(++seq).padStart(6, '0')}`;

const ESTABLISHED: Payee[] = [
  { id: 'P-CHURCH', displayName: 'Riverside Community Church', email: 'giving@riversidecc.org', firstSeenAt: dayIso(-900), established: true },
  { id: 'P-PHARM', displayName: "Hartley's Pharmacy", email: 'pay@hartleyrx.com', firstSeenAt: dayIso(-860), established: true },
  { id: 'P-YARN', displayName: 'YarnBarn Supplies', email: 'orders@yarnbarn.etsy.com', firstSeenAt: dayIso(-700), established: true },
  { id: 'P-DANA', displayName: 'Dana Ellis', email: 'dana.ellis@example.com', firstSeenAt: dayIso(-880), claimedRelationship: 'daughter', established: true },
  { id: 'P-TOM', displayName: 'Thomas Ellis', email: 'tom.ellis@example.com', firstSeenAt: dayIso(-640), claimedRelationship: 'grandson', established: true },
  { id: 'P-GROC', displayName: 'Sunrise Grocery Delivery', email: 'billing@sunrisegrocery.com', firstSeenAt: dayIso(-500), established: true },
  { id: 'P-UTIL', displayName: 'Valley Electric', email: 'autopay@valleyelectric.com', firstSeenAt: dayIso(-870), established: true },
];

/** 24 months of unremarkable life. */
function baseline(seedN: number): Txn[] {
  const r = rng(seedN);
  const out: Txn[] = [];
  for (let m = 24; m >= 0; m--) {
    const base = -m * 30;
    out.push({ id: tid(), ts: dayIso(base + 2), amountCents: 4000, currency: 'USD', payeeId: 'P-CHURCH', direction: 'out', memo: 'Monthly giving', instrument: 'paypal_balance', status: 'completed' });
    out.push({ id: tid(), ts: dayIso(base + 5), amountCents: 11200 + Math.floor(r() * 4000), currency: 'USD', payeeId: 'P-UTIL', direction: 'out', memo: 'Autopay', instrument: 'bank', status: 'completed' });
    out.push({ id: tid(), ts: dayIso(base + 9), amountCents: 2800 + Math.floor(r() * 3000), currency: 'USD', payeeId: 'P-PHARM', direction: 'out', memo: 'Prescription pickup', instrument: 'card', status: 'completed' });
    out.push({ id: tid(), ts: dayIso(base + 12), amountCents: 7400 + Math.floor(r() * 5000), currency: 'USD', payeeId: 'P-GROC', direction: 'out', memo: 'Weekly delivery', instrument: 'card', status: 'completed' });
    out.push({ id: tid(), ts: dayIso(base + 22), amountCents: 6900 + Math.floor(r() * 6000), currency: 'USD', payeeId: 'P-GROC', direction: 'out', memo: 'Weekly delivery', instrument: 'card', status: 'completed' });
    if (m % 3 === 0) out.push({ id: tid(), ts: dayIso(base + 17), amountCents: 3200 + Math.floor(r() * 2500), currency: 'USD', payeeId: 'P-YARN', direction: 'out', memo: 'Wool + needles', instrument: 'card', status: 'completed' });
    // Genuine family ties flow BOTH ways. This is what makes reciprocity_absence meaningful.
    if (m % 4 === 0) out.push({ id: tid(), ts: dayIso(base + 19), amountCents: 5000, currency: 'USD', payeeId: 'P-TOM', direction: 'out', memo: 'Birthday', instrument: 'paypal_balance', status: 'completed' });
    if (m % 6 === 0) out.push({ id: tid(), ts: dayIso(base + 25), amountCents: 12000, currency: 'USD', payeeId: 'P-DANA', direction: 'in', memo: 'Share of the garden work', instrument: 'paypal_balance', status: 'completed' });
    if (m % 5 === 0) out.push({ id: tid(), ts: dayIso(base + 27), amountCents: 4500, currency: 'USD', payeeId: 'P-DANA', direction: 'out', memo: 'Lunch + the plants', instrument: 'paypal_balance', status: 'completed' });
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

function account(partial: Partial<Account>): Account {
  return {
    personName: 'Margaret Ellis',
    personAgeBand: '70-79',
    accountOpenedAt: dayIso(-900),
    payees: [...ESTABLISHED],
    transactions: [],
    notes: [],
    trustedContact: { name: 'Dana Ellis', relationship: 'daughter', email: 'dana.ellis@example.com' },
    ...partial,
  };
}

const SCENARIOS: Record<string, () => Account> = {
  /** PRIMARY DEMO. Intercept the third payment, with the escalation already visible. */
  grandparent: () => {
    seq = 0;
    const txns = baseline(1);
    const payee: Payee = { id: 'P-ALVAREZ', displayName: 'R. Alvarez Legal Services', email: 'ralvarez.legal.intl@fastmail-secure.net', firstSeenAt: dayIso(-9), claimedRelationship: "grandson's lawyer", established: false };
    const notes: ContextNote[] = [
      { ts: dayIso(-9), source: 'call_note', text: "Call this morning from someone saying he was Tommy. Said he'd been in a car accident in Mexico and was being held. His voice sounded different but he said his nose was broken." },
      { ts: dayIso(-9), source: 'call_note', text: "He said please don't tell Mom, she would never forgive him. Asked me to keep it between us." },
      { ts: dayIso(-8), source: 'chat', text: "Mr Alvarez says the bail has to be posted today or he stays the weekend. He asked me to send it as a friends transfer so it clears faster." },
      { ts: dayIso(-6), source: 'sms', text: "Grandma the hospital needs a medical fee of 2,400 before they will release the paperwork. Please don't tell anyone, I'm so ashamed about all this." },
      { ts: dayIso(-3), source: 'call_note', text: "Mr Alvarez said I should not discuss the case with my bank because they will freeze the funds and delay everything." },
      { ts: dayIso(-1), source: 'chat', text: "He says the court costs are 3,800 and this is the last thing. Then Tommy can come home." },
    ];
    txns.push(
      { id: tid(), ts: dayIso(-8), amountCents: 120000, currency: 'USD', payeeId: 'P-ALVAREZ', direction: 'out', memo: 'Tommy bail', instrument: 'paypal_balance', status: 'completed' },
      { id: tid(), ts: dayIso(-6), amountCents: 240000, currency: 'USD', payeeId: 'P-ALVAREZ', direction: 'out', memo: 'medical fee', instrument: 'paypal_balance', status: 'completed' },
      { id: tid(), ts: dayIso(-0.02), amountCents: 380000, currency: 'USD', payeeId: 'P-ALVAREZ', direction: 'out', memo: 'court costs for Tommy', instrument: 'paypal_balance', status: 'pending' },
    );
    return account({ payees: [...ESTABLISHED, payee], transactions: txns.sort((a, b) => a.ts.localeCompare(b.ts)), notes, _groundTruth: { script: 'grandparent', stage: 5, note: 'Third payment, escalating. Intercept target is the pending 3,800.' } });
  },

  /** The good outcome: caught at the secrecy stage, before any money moves. */
  grandparent_early: () => {
    seq = 0;
    const txns = baseline(2);
    const payee: Payee = { id: 'P-ALVAREZ', displayName: 'R. Alvarez Legal Services', email: 'ralvarez.legal.intl@fastmail-secure.net', firstSeenAt: dayIso(-0.5), claimedRelationship: "grandson's lawyer", established: false };
    const notes: ContextNote[] = [
      { ts: dayIso(-0.6), source: 'call_note', text: "Someone called saying he was Tommy and he'd been arrested after a crash. Said not to tell his mother under any circumstances." },
      { ts: dayIso(-0.4), source: 'chat', text: "A Mr Alvarez came on the line, said he is the attorney and bail must be posted within the hour or Tommy stays until Monday." },
    ];
    txns.push({ id: tid(), ts: dayIso(-0.02), amountCents: 120000, currency: 'USD', payeeId: 'P-ALVAREZ', direction: 'out', memo: 'bail for Tommy urgent', instrument: 'paypal_balance', status: 'pending' });
    return account({ payees: [...ESTABLISHED, payee], transactions: txns.sort((a, b) => a.ts.localeCompare(b.ts)), notes, _groundTruth: { script: 'grandparent', stage: 3, note: 'Caught before any money has moved.' } });
  },

  pig_butchering: () => {
    seq = 0;
    const txns = baseline(3);
    const payee: Payee = { id: 'P-MERIDIAN', displayName: 'Meridian Capital Exchange', email: 'deposits@meridian-cap-ex.io', firstSeenAt: dayIso(-54), established: false };
    const notes: ContextNote[] = [
      { ts: dayIso(-80), source: 'self_reported', text: "Wen messaged me by mistake looking for someone else and we got talking. Very easy to talk to. Lost her father last year too." },
      { ts: dayIso(-60), source: 'chat', text: "She showed me the platform her uncle set her up on. She said start small, see for yourself, there is no pressure at all." },
      { ts: dayIso(-54), source: 'chat', text: "Put in 500 to see. The dashboard already shows it up nearly 9 percent." },
      { ts: dayIso(-40), source: 'self_reported', text: "Took out 300 with no trouble at all. It came straight through. I feel much better about it now." },
      { ts: dayIso(-12), source: 'chat', text: "Wen says the quarterly window closes Friday and after that the minimum goes up a lot. She is putting in more herself." },
      { ts: dayIso(-0.5), source: 'chat', text: "To withdraw I have to clear a capital gains settlement of 6,000 first. She says everyone has to do it, she did hers last month." },
    ];
    txns.push(
      { id: tid(), ts: dayIso(-54), amountCents: 50000, currency: 'USD', payeeId: 'P-MERIDIAN', direction: 'out', memo: 'test deposit', instrument: 'paypal_balance', status: 'completed' },
      { id: tid(), ts: dayIso(-40), amountCents: 30000, currency: 'USD', payeeId: 'P-MERIDIAN', direction: 'in', memo: 'withdrawal', instrument: 'paypal_balance', status: 'completed' },
      { id: tid(), ts: dayIso(-12), amountCents: 1800000, currency: 'USD', payeeId: 'P-MERIDIAN', direction: 'out', memo: 'quarterly allocation', instrument: 'bank', status: 'completed' },
      { id: tid(), ts: dayIso(-0.02), amountCents: 600000, currency: 'USD', payeeId: 'P-MERIDIAN', direction: 'out', memo: 'settlement to release funds', instrument: 'bank', status: 'pending' },
    );
    return account({ payees: [...ESTABLISHED, payee], transactions: txns.sort((a, b) => a.ts.localeCompare(b.ts)), notes, _groundTruth: { script: 'pig_butchering', stage: 6, note: 'Exit-fee stage. The 18,000 is already gone.' } });
  },

  romance: () => {
    seq = 0;
    const txns = baseline(4);
    const payee: Payee = { id: 'P-COLE', displayName: 'Cole Brennan', email: 'cole.brennan.eng@mail-relay.cc', firstSeenAt: dayIso(-150), claimedRelationship: 'partner', established: false };
    const notes: ContextNote[] = [
      { ts: dayIso(-170), source: 'self_reported', text: "Cole is an engineer on a contract overseas. We talk every evening. He is the first person since Ray that I look forward to hearing from." },
      { ts: dayIso(-150), source: 'chat', text: "His card is blocked by the company bank until the contract clears. He hated having to ask." },
      { ts: dayIso(-95), source: 'chat', text: "The flight home was cancelled and the rebooking fee is not covered. He will pay me back the moment he lands." },
      { ts: dayIso(-30), source: 'chat', text: "Customs are holding his equipment and want a release fee. He says it is the last hurdle before he can come." },
      { ts: dayIso(-4), source: 'self_reported', text: "Dana asked me again whether I had ever actually seen him on video. Cole says she is only trying to keep me to herself." },
      { ts: dayIso(-0.5), source: 'chat', text: "He needs 2,200 for the medical clearance. He asked me not to mention it to Dana because of how she has been about him." },
    ];
    txns.push(
      { id: tid(), ts: dayIso(-150), amountCents: 40000, currency: 'USD', payeeId: 'P-COLE', direction: 'out', memo: 'helping out', instrument: 'paypal_balance', status: 'completed' },
      { id: tid(), ts: dayIso(-95), amountCents: 85000, currency: 'USD', payeeId: 'P-COLE', direction: 'out', memo: 'flight', instrument: 'paypal_balance', status: 'completed' },
      { id: tid(), ts: dayIso(-30), amountCents: 140000, currency: 'USD', payeeId: 'P-COLE', direction: 'out', memo: 'customs release', instrument: 'paypal_balance', status: 'completed' },
      { id: tid(), ts: dayIso(-0.02), amountCents: 220000, currency: 'USD', payeeId: 'P-COLE', direction: 'out', memo: 'medical clearance', instrument: 'paypal_balance', status: 'pending' },
    );
    return account({ payees: [...ESTABLISHED, payee], transactions: txns.sort((a, b) => a.ts.localeCompare(b.ts)), notes, _groundTruth: { script: 'romance', stage: 5, note: 'Isolation stage; trusted contact already raised concern.' } });
  },

  /** CONTROL 1: an ordinary month. The system should say nothing. */
  clean: () => {
    seq = 0;
    const txns = baseline(5);
    txns.push({ id: tid(), ts: dayIso(-0.02), amountCents: 8200, currency: 'USD', payeeId: 'P-GROC', direction: 'out', memo: 'Weekly delivery', instrument: 'card', status: 'pending' });
    return account({ transactions: txns.sort((a, b) => a.ts.localeCompare(b.ts)), notes: [{ ts: dayIso(-2), source: 'self_reported', text: 'Dana and the children are coming Sunday. Need to order extra.' }], _groundTruth: { script: 'none', stage: 0, note: 'Ordinary month. Must stay silent.' } });
  },

  /**
   * CONTROL 2: large, round, brand-new payee, biggest payment in two years.
   * Numerically this is the most alarming transaction in any fixture. There is
   * no narrative around it. The system must let it through.
   */
  legit_large: () => {
    seq = 0;
    const txns = baseline(6);
    const payee: Payee = { id: 'P-ROOF', displayName: 'Calloway Roofing LLC', email: 'invoices@callowayroofing.com', firstSeenAt: dayIso(-11), established: false };
    const notes: ContextNote[] = [
      { ts: dayIso(-11), source: 'self_reported', text: 'Calloway came out to look at the porch roof after the storm. Dana found them and sat in on the quote.' },
      { ts: dayIso(-4), source: 'self_reported', text: 'Quote came to 4,200 for the whole porch side. Two other quotes were higher. Starting the week after next.' },
    ];
    txns.push(
      { id: tid(), ts: dayIso(-4), amountCents: 50000, currency: 'USD', payeeId: 'P-ROOF', direction: 'out', memo: 'Deposit - porch roof', instrument: 'card', status: 'completed' },
      { id: tid(), ts: dayIso(-0.02), amountCents: 420000, currency: 'USD', payeeId: 'P-ROOF', direction: 'out', memo: 'Balance - porch roof, invoice 2291', instrument: 'bank', status: 'pending' },
    );
    return account({ payees: [...ESTABLISHED, payee], transactions: txns.sort((a, b) => a.ts.localeCompare(b.ts)), notes, _groundTruth: { script: 'none', stage: 0, note: 'Legitimate. Numerically alarming, narratively innocent. Must not flag.' } });
  },
};

mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [name, build] of Object.entries(SCENARIOS)) {
  const acct = build();
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(acct, null, 2));
  total += acct.transactions.length;
  const pending = acct.transactions.filter((t) => t.status === 'pending').length;
  console.log(
    `${name.padEnd(20)} ${String(acct.transactions.length).padStart(4)} txns  ${acct.notes.length} notes  ${pending} pending  truth=${acct._groundTruth?.script}:${acct._groundTruth?.stage}`,
  );
}
console.log(`\n${Object.keys(SCENARIOS).length} fixtures, ${total} transactions total -> fixtures/`);
