import type { ScriptId, SignalKind } from './scripts/taxonomy.ts';

export interface Payee {
  id: string;
  displayName: string;
  email: string;
  /** ISO date the payee was first transacted with / added. */
  firstSeenAt: string;
  /** Relationship the *person* believes they have, if any was asserted. */
  claimedRelationship?: string;
  /** True when this payee has a long, reciprocal, unremarkable history. */
  established: boolean;
}

export interface Txn {
  id: string;
  ts: string;                      // ISO
  amountCents: number;
  currency: string;
  payeeId: string;
  direction: 'out' | 'in';
  memo: string;
  instrument: 'paypal_balance' | 'card' | 'bank' | 'gift_card' | 'crypto';
  status: 'completed' | 'pending';
}

/**
 * Context that is not a transaction: message fragments, call notes, what the
 * person said when they set the payment up. In production this comes from the
 * optional companion app and from what the person types into the memo. It is
 * the richest source of narrative signal and the reason an LLM is the right
 * tool here.
 */
export interface ContextNote {
  ts: string;
  source: 'memo' | 'sms' | 'call_note' | 'chat' | 'self_reported';
  text: string;
}

export interface Account {
  personName: string;
  personAgeBand: string;
  accountOpenedAt: string;
  payees: Payee[];
  transactions: Txn[];
  notes: ContextNote[];
  /** Pre-designated trusted contact, consented to in advance by the person. */
  trustedContact: { name: string; relationship: string; email: string } | null;
  /** Ground truth, present only in fixtures, never shown to the classifier. */
  _groundTruth?: { script: ScriptId; stage: number; note: string };
}

export interface Signal {
  kind: SignalKind;
  evidence: string;
  /** Which transaction or note this was read off, for the audit trail. */
  sourceRef?: string;
}

export interface PredictedMove {
  within: string;
  description: string;
  confidence: number;
}

export interface Assessment {
  script: ScriptId;
  scriptLabel: string;
  stage: number;
  stageCount: number;
  stageName: string;
  confidence: number;                 // 0..1
  signals: Signal[];
  predictedNextMoves: PredictedMove[];
  /** 0 = log only … 4 = ask trusted contact to co-sign. Never a hard block. */
  tier: 0 | 1 | 2 | 3 | 4;
  /** What we actually say to the person. Plain, short, non-condescending. */
  plainLanguage: string;
  /** Why we are not certain. Shown in the console, not to the person. */
  uncertainty: string;
  engine: 'llm' | 'offline';
}
