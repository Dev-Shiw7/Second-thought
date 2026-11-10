/**
 * Assessment orchestrator.
 *
 * Pipeline: ledger -> deterministic features -> signals -> classification.
 *
 * The model path and the offline path consume the SAME extracted features and
 * the SAME signal vocabulary, which is what makes them comparable. The model is
 * not handed raw data and asked to be clever; it is handed exact computed facts
 * and asked the questions only a language model can answer.
 */
import { readFileSync } from 'node:fs';
import type { Account, Assessment, Signal } from '../types.ts';
import { extract, lexicalSignals, structuralSignals, type Features } from './features.ts';
import { assessOffline } from './offline.ts';

export interface AssessOptions {
  /** Force the offline scorer even when an API key is present. */
  forceOffline?: boolean;
}

export function loadAccount(path: string): Account {
  return JSON.parse(readFileSync(path, 'utf8')) as Account;
}

/** Signals available without any model call. */
export function baseSignals(acct: Account, f: Features): Signal[] {
  return [...structuralSignals(f), ...lexicalSignals(acct)];
}

export async function assess(acct: Account, opts: AssessOptions = {}): Promise<Assessment> {
  const f = extract(acct);
  const signals = baseSignals(acct, f);

  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  if (opts.forceOffline || !hasKey) {
    return assessOffline(signals, f);
  }

  try {
    const { assessWithModel } = await import('./llm.ts');
    return await assessWithModel(acct, f, signals);
  } catch (err) {
    const offline = assessOffline(signals, f);
    offline.uncertainty =
      'Model path unavailable (' +
      (err instanceof Error ? err.message : String(err)) +
      '). Fell back to the offline scorer. ' +
      offline.uncertainty;
    return offline;
  }
}

export { extract };
export type { Features };
