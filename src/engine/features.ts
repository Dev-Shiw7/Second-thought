/**
 * Deterministic feature extraction.
 *
 * Division of labour, deliberately: anything computable from the ledger is
 * computed here, exactly, and never asked of a language model — payee age,
 * escalation curves, reciprocity, amount ratios against the person's own
 * baseline, hour-of-day. The model is then asked only about what is genuinely
 * linguistic and genuinely hard: is this secrecy coaching or an ordinary
 * request for discretion? Is this urgency real or manufactured?
 *
 * The lexical matching below is the weakest component in the system. It exists
 * so the project runs without an API key, and it is deliberately conservative.
 * Where the two engines disagree, the model is better; where the model is
 * unavailable, this degrades predictably rather than silently.
 */
import type { Account, Txn, Signal } from '../types.ts';
import type { SignalKind } from '../scripts/taxonomy.ts';

export interface Features {
  pending: Txn | null;
  payeeDisplayName: string;
  payeeAgeDays: number | null;
  payeeEstablished: boolean;
  claimedRelationship: string | null;
  /** Outbound total to this payee before the pending one, in cents. */
  priorOutboundCents: number;
  priorOutboundCount: number;
  inboundFromPayeeCents: number;
  /** Outbound amounts to this payee, oldest first, including pending. */
  amountSequence: number[];
  strictlyEscalating: boolean;
  /** Pending amount as a multiple of the person's median outbound payment. */
  medianOutboundCents: number;
  pendingVsMedian: number;
  /** Largest single outbound in the 24 months before the pending one. */
  priorMaxOutboundCents: number;
  pendingVsPriorMax: number;
  allRoundHundreds: boolean;
  localHour: number;
  offHours: boolean;
  instrumentUnusual: boolean;
  /** Share of all outbound value in the last 14 days, vs the trailing average. */
  recentVelocityMultiple: number;
  noteCount: number;
}

const cents = (t: Txn) => t.amountCents;

export function extract(acct: Account): Features {
  const pending = acct.transactions.find((t) => t.status === 'pending') ?? null;
  const completed = acct.transactions.filter((t) => t.status === 'completed');
  const outbound = completed.filter((t) => t.direction === 'out');

  const payee = pending ? acct.payees.find((p) => p.id === pending.payeeId) ?? null : null;
  const toPayee = outbound.filter((t) => pending && t.payeeId === pending.payeeId);
  const fromPayee = completed.filter((t) => pending && t.payeeId === pending.payeeId && t.direction === 'in');

  const sorted = [...outbound].map(cents).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  const priorMax = sorted.length ? sorted[sorted.length - 1]! : 0;

  const seq = [...toPayee.sort((a, b) => a.ts.localeCompare(b.ts)).map(cents)];
  if (pending) seq.push(cents(pending));
  const strictlyEscalating = seq.length >= 3 && seq.every((v, i) => i === 0 || v > seq[i - 1]!);

  // Instrument familiarity: how often has this person used this instrument before?
  const instrUse = new Map<string, number>();
  for (const t of outbound) instrUse.set(t.instrument, (instrUse.get(t.instrument) ?? 0) + 1);
  const instrumentUnusual = pending ? (instrUse.get(pending.instrument) ?? 0) < 3 : false;

  // Velocity: outbound value in the trailing 14 days vs the per-14-day average.
  const now = pending ? new Date(pending.ts).getTime() : Date.now();
  const d14 = 14 * 86400000;
  const recent = outbound.filter((t) => now - new Date(t.ts).getTime() <= d14).reduce((s, t) => s + cents(t), 0);
  const spanDays = outbound.length
    ? Math.max(1, (now - new Date(outbound[0]!.ts).getTime()) / 86400000)
    : 1;
  const avg14 = (outbound.reduce((s, t) => s + cents(t), 0) / spanDays) * 14;
  const recentVelocityMultiple = avg14 > 0 ? recent / avg14 : 0;

  const localHour = pending ? new Date(pending.ts).getUTCHours() : 12;
  const priorOut = toPayee.reduce((s, t) => s + cents(t), 0);

  return {
    pending,
    payeeDisplayName: payee?.displayName ?? '(unknown)',
    payeeAgeDays: payee && pending
      ? Math.round((new Date(pending.ts).getTime() - new Date(payee.firstSeenAt).getTime()) / 86400000)
      : null,
    payeeEstablished: payee?.established ?? false,
    claimedRelationship: payee?.claimedRelationship ?? null,
    priorOutboundCents: priorOut,
    priorOutboundCount: toPayee.length,
    inboundFromPayeeCents: fromPayee.reduce((s, t) => s + cents(t), 0),
    amountSequence: seq,
    strictlyEscalating,
    medianOutboundCents: median,
    pendingVsMedian: pending && median ? cents(pending) / median : 0,
    priorMaxOutboundCents: priorMax,
    pendingVsPriorMax: pending && priorMax ? cents(pending) / priorMax : 0,
    allRoundHundreds: seq.length >= 2 && seq.every((v) => v % 10000 === 0),
    localHour,
    offHours: localHour >= 23 || localHour < 6,
    instrumentUnusual,
    recentVelocityMultiple,
    noteCount: acct.notes.length,
  };
}

/* ------------------------------------------------------------------ *
 * Lexical signal families. Conservative on purpose: a false "secrecy"
 * reading is expensive because that signal carries the most weight.
 * ------------------------------------------------------------------ */
const LEX: { kind: SignalKind; patterns: RegExp[] }[] = [
  { kind: 'secrecy_instruction', patterns: [
    /don'?t tell\b/i, /do not tell\b/i, /\bnot to tell\b/i,
    /keep (?:this|it) (?:between us|private|quiet|to yourself)/i,
    /not (?:to )?mention (?:it|this)/i, /without telling/i, /our secret/i, /don'?t (?:let|say anything to)/i,
  ]},
  { kind: 'isolation_language', patterns: [
    /not (?:to )?(?:discuss|talk|speak).{0,30}\b(?:bank|police|family|daughter|son)/i,
    /they (?:will|would) (?:freeze|block|delay)/i, /only trying to (?:keep|turn)/i,
    /(?:jealous|interfering|keep me to herself|keep you to)/i, /stay on the line/i, /don'?t hang up/i,
  ]},
  { kind: 'authority_impersonation', patterns: [
    /\b(?:IRS|FBI|police|sheriff|customs|immigration|social security|medicare)\b/i,
    /\b(?:warrant|arrest|deport|prosecut)/i, /fraud department/i, /\bMicrosoft\b|\bApple support\b/i,
    /your (?:computer|device|account) (?:is|has been) (?:infected|compromised|hacked)/i,
  ]},
  { kind: 'manufactured_urgency', patterns: [
    /\b(?:today|within the hour|right away|immediately|before (?:5|noon|close))\b/i,
    /(?:has|have) to be (?:posted|paid|sent) (?:today|now)/i, /window closes/i, /or he stays/i,
    /last (?:thing|hurdle|step)/i, /\burgent\b/i,
  ]},
  { kind: 'instrument_steering', patterns: [
    /gift card/i, /\bcrypto|bitcoin|usdt\b/i, /wire transfer/i, /friends? (?:and family )?transfer/i,
    /so it clears faster/i, /safe account/i,
  ]},
  { kind: 'advance_fee', patterns: [
    /(?:fee|tax|settlement|clearance|customs|release).{0,40}(?:before|to release|to withdraw|first)/i,
    /(?:before|first).{0,40}(?:release|withdraw|collect)/i, /capital gains settlement/i,
    /release fee/i, /medical clearance/i,
  ]},
  { kind: 'overpayment_refund', patterns: [
    /(?:refund|credited|deposited).{0,40}(?:too much|by mistake|in error)/i,
    /send (?:the )?difference back/i, /return the (?:extra|difference|overpay)/i,
  ]},
  { kind: 'relationship_claim', patterns: [
    /\b(?:grandma|grandmother|grandson|granddaughter|nana)\b/i,
    /saying he was|claiming to be|said he was/i, /\bmy (?:partner|fianc|boyfriend|girlfriend)/i,
  ]},
  { kind: 'test_then_scale', patterns: [
    /start small/i, /see for yourself/i, /took out .{0,20}(?:no trouble|came straight)/i,
    /test deposit/i, /minimum goes up/i,
  ]},
];

export function lexicalSignals(acct: Account): Signal[] {
  const out: Signal[] = [];
  const seen = new Set<string>();
  const haystack = [
    ...acct.notes.map((n) => ({ text: n.text, ref: `note@${n.ts}` })),
    ...acct.transactions.filter((t) => t.memo).map((t) => ({ text: t.memo, ref: t.id })),
  ];
  for (const { kind, patterns } of LEX) {
    for (const { text, ref } of haystack) {
      const hit = patterns.find((p) => p.test(text));
      if (hit && !seen.has(kind)) {
        seen.add(kind);
        const m = text.match(hit);
        const idx = m?.index ?? 0;
        const excerpt = text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + 90)).trim();
        out.push({ kind, evidence: `"…${excerpt}…"`, sourceRef: ref });
        break;
      }
    }
  }
  return out;
}

/** Signals that fall out of the ledger alone, with no language involved. */
export function structuralSignals(f: Features): Signal[] {
  const out: Signal[] = [];
  if (f.payeeAgeDays !== null && f.payeeAgeDays <= 14 && !f.payeeEstablished)
    out.push({ kind: 'new_payee', evidence: `${f.payeeDisplayName} was first seen ${f.payeeAgeDays} day(s) before this payment.` });
  if (f.claimedRelationship && f.payeeAgeDays !== null && f.payeeAgeDays <= 30)
    out.push({ kind: 'relationship_mismatch', evidence: `Claimed relationship "${f.claimedRelationship}" but no history before ${f.payeeAgeDays} day(s) ago.` });
  if (f.strictlyEscalating)
    out.push({ kind: 'escalation_curve', evidence: `Payments to this recipient rise each time: ${f.amountSequence.map((c) => '$' + (c / 100).toLocaleString()).join(' → ')}.` });
  if (f.priorOutboundCount >= 2 && f.inboundFromPayeeCents === 0)
    out.push({ kind: 'reciprocity_absence', evidence: `${f.priorOutboundCount} payments out to this recipient, nothing ever received back.` });
  if (f.allRoundHundreds && f.amountSequence.length >= 3)
    out.push({ kind: 'round_number_sequence', evidence: 'Every payment in the sequence is a round hundred.' });
  if (f.offHours)
    out.push({ kind: 'off_hours', evidence: `Payment initiated at ${String(f.localHour).padStart(2, '0')}:00, outside this person's usual hours.` });
  if (f.recentVelocityMultiple >= 3)
    out.push({ kind: 'velocity_break', evidence: `Outbound value in the last 14 days is ${f.recentVelocityMultiple.toFixed(1)}× this person's normal rate.` });
  if (f.inboundFromPayeeCents > 0 && f.priorOutboundCount >= 1 && f.pendingVsPriorMax > 1)
    out.push({ kind: 'test_then_scale', evidence: `A small amount came back ($${(f.inboundFromPayeeCents / 100).toLocaleString()}) before a much larger request.` });
  return out;
}
