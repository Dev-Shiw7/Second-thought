/**
 * Offline scorer - runs with no API key so judges can execute the project.
 *
 * Deliberately conservative. It is weaker than the model path at exactly the
 * place that matters (reading intent in language), and the README says so.
 * What it does do is make the system's behaviour reproducible and inspectable,
 * which is also why it is the engine used for the regression tests.
 */
import { SCRIPTS, SIGNAL_WEIGHT, SIGNAL_LABEL } from '../scripts/taxonomy.ts';
import type { ScriptId, SignalKind, ScamScript } from '../scripts/taxonomy.ts';
import type { Assessment, Signal, PredictedMove } from '../types.ts';
import type { Features } from './features.ts';

/** Below this total weight we say nothing at all. Tuned against the controls. */
const FLAG_THRESHOLD = 20;
/** A signal at or above this weight is distinctive enough to mark a stage reached. */
const DISTINCTIVE = 8;

const w = (k: SignalKind) => SIGNAL_WEIGHT[k] ?? 0;

/**
 * How many scripts contain each signal. A signal present in every script says
 * almost nothing about which one is running; a rare one says a great deal.
 * Computed once from the taxonomy rather than hand-tuned.
 */
const DOC_FREQ: Map<SignalKind, number> = (() => {
  const m = new Map<SignalKind, number>();
  for (const s of SCRIPTS) {
    for (const k of new Set<SignalKind>(s.stages.flatMap((st) => st.signals))) {
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return m;
})();

/** Inverse document frequency over the script corpus. */
function idf(k: SignalKind): number {
  const df = DOC_FREQ.get(k) ?? SCRIPTS.length;
  return Math.log(SCRIPTS.length / df);
}

/**
 * Discriminative mass, NOT normalised by the script's own vocabulary.
 *
 * An earlier version divided by the script's total possible weight, which
 * systematically favoured scripts with few stages - a three-stage script could
 * reach a perfect ratio on two signals and beat a five-stage script that
 * matched far more evidence. Ranking on absolute matched mass, weighted by how
 * discriminative each signal is, removes that bias.
 */
function scoreScript(script: ScamScript, observed: Set<SignalKind>, payeeAgeDays: number | null): number {
  const union = new Set<SignalKind>(script.stages.flatMap((s) => s.signals));
  let matched = 0;
  for (const k of union) {
    if (observed.has(k)) matched += w(k) * (1 + idf(k));
  }
  // Temporal prior: does the age of this relationship fit how this script runs?
  if (payeeAgeDays !== null) {
    const [lo, hi] = script.expectedPayeeAgeDays;
    matched *= payeeAgeDays >= lo && payeeAgeDays <= hi ? 1.25 : 0.7;
  }
  return matched;
}

/**
 * A stage counts as reached on either of two routes.
 *
 * The first is a distinctive high-weight signal. On its own that rule was
 * badly broken: only four signal kinds weigh >= 8, so 19 of the 24 stages in
 * the taxonomy could never be reached by it at all. In practice the stage got
 * pinned to wherever secrecy or isolation sat and no later stage could ever be
 * reported, even with the evidence for it in hand. That is the one error this
 * system cannot afford, because the stage chooses the prediction shown to the
 * person - and a prediction of something that has already happened is worse
 * than saying nothing.
 *
 * The second route is proportional: enough of THIS stage's own vocabulary is
 * present, judged against that stage rather than against a global cut-off. The
 * weight floor stops a stage being claimed on nothing but new_payee and
 * off_hours, which almost every stage in every script contains.
 */
const STAGE_COVERAGE = 0.5;

function stageReached(st: ScamScript['stages'][number], observed: Set<SignalKind>): boolean {
  if (st.signals.some((k) => observed.has(k) && w(k) >= DISTINCTIVE)) return true;
  const possible = st.signals.reduce((acc, k) => acc + w(k), 0);
  if (possible === 0) return false;
  const got = st.signals.reduce((acc, k) => acc + (observed.has(k) ? w(k) : 0), 0);
  const substantive = st.signals.some((k) => observed.has(k) && w(k) >= 5);
  return substantive && got / possible >= STAGE_COVERAGE;
}

function pickStage(script: ScamScript, observed: Set<SignalKind>): number {
  const observedWeight = (st: ScamScript['stages'][number]) =>
    st.signals.reduce((acc, k) => acc + (observed.has(k) ? w(k) : 0), 0);

  let reached = 0;
  for (const st of script.stages) {
    if (stageReached(st, observed)) {
      reached = Math.max(reached, st.n);
    }
  }

  /**
   * Coverage alone under-reports the late stages, because a stage is penalised
   * for the signals it does NOT contain evidence for. `pig_butchering` stage 6
   * is "exit fee": advance_fee, its defining signal, is present, but the stage
   * also lists isolation_language, which this narrative never states, so it
   * scores 0.44 and loses to stage 5 at 0.54. Reading that as "they have not
   * reached the exit fee yet" is wrong when the exit fee is the thing on the
   * screen.
   *
   * So among stages carrying at least as much observed evidence as the latest
   * reached one, report the latest. Being conservative about stage means
   * predicting a move the person has already seen, which is the failure that
   * costs their trust.
   */
  if (reached) {
    const base = observedWeight(script.stages.find((st) => st.n === reached)!);
    for (const st of script.stages) {
      if (st.n > reached && observedWeight(st) >= base) reached = st.n;
    }
    return reached;
  }
  if (reached) return reached;
  // Otherwise fall back to the stage with the greatest observed weight, latest wins ties.
  let best = script.stages[0]!.n;
  let bestScore = -1;
  for (const st of script.stages) {
    const s = st.signals.reduce((acc, k) => acc + (observed.has(k) ? w(k) : 0), 0);
    if (s >= bestScore) {
      bestScore = s;
      best = st.n;
    }
  }
  return best;
}

export function assessOffline(signals: Signal[], f: Features): Assessment {
  const observed = new Set<SignalKind>(signals.map((s) => s.kind));
  const total = [...observed].reduce((acc, k) => acc + w(k), 0);
  const strong = [...observed].filter((k) => w(k) >= 5).length;

  if (total < FLAG_THRESHOLD || strong < 2) {
    return {
      script: 'none',
      scriptLabel: 'No script detected',
      stage: 0,
      stageCount: 0,
      stageName: '-',
      confidence: Math.min(0.3, total / 60),
      signals,
      predictedNextMoves: [],
      tier: 0,
      plainLanguage: '',
      uncertainty:
        'Observed signal weight ' + total + ' is below the reporting threshold of ' +
        FLAG_THRESHOLD + '. Nothing is shown to the person.',
      engine: 'offline',
    };
  }

  const ranked = SCRIPTS.map((s) => ({ s, score: scoreScript(s, observed, f.payeeAgeDays) })).sort(
    (a, b) => b.score - a.score,
  );
  const top = ranked[0]!;
  const runnerUp = ranked[1];
  const script = top.s;
  const stage = pickStage(script, observed);
  const stageDef = script.stages.find((st) => st.n === stage) ?? script.stages[0]!;

  /**
   * Confidence has two independent parts: how much evidence there is at all,
   * and how cleanly the leading script separates from the next best. A pile of
   * evidence that fits three scripts equally well should not read as certain.
   */
  const evidenceFactor = Math.min(1, total / 55);
  const separation = top.score > 0 && runnerUp ? (top.score - runnerUp.score) / top.score : 1;
  const confidence = Math.min(0.95, 0.6 * evidenceFactor + 0.4 * separation);

  const predictedNextMoves: PredictedMove[] = [];
  if (stageDef.nextMove) {
    predictedNextMoves.push({ ...stageDef.nextMove, confidence: Math.min(0.9, confidence + 0.05) });
  }
  const following = script.stages.find((st) => st.n === stage + 1);
  if (following?.nextMove) {
    predictedNextMoves.push({ ...following.nextMove, confidence: Math.max(0.3, confidence - 0.2) });
  }

  const tier = chooseTier(confidence, f, signals);

  const uncertainty =
    separation < 0.2 && runnerUp
      ? 'Close call between "' + script.label + '" and "' + runnerUp.s.label + '" (' +
        top.score.toFixed(1) + ' vs ' + runnerUp.score.toFixed(1) + ', separation ' +
        (separation * 100).toFixed(0) +
        '%). Shared signals make these hard to separate from the ledger alone.'
      : 'Scored from ' + signals.length + ' signals, total weight ' + total +
        '; leading script separates from the next by ' + (separation * 100).toFixed(0) +
        '%. Offline engine: lexical matching only, no intent modelling.';

  return {
    script: script.id as ScriptId,
    scriptLabel: script.label,
    stage,
    stageCount: script.stages.length,
    stageName: stageDef.name,
    confidence,
    signals,
    predictedNextMoves,
    tier,
    plainLanguage: plainLanguageOffline(script, signals, f),
    uncertainty,
    engine: 'offline',
  };
}

/**
 * Tier ladder. Nothing here ever blocks a payment - the highest tier asks a
 * pre-designated contact to co-sign, and the person can still proceed.
 */
/**
 * Which rung of the intervention ladder this assessment earns.
 *
 * Driven by observed evidence mass, NOT by the engine's own confidence. The
 * offline scorer derives confidence from evidence, so the two agreed closely
 * enough that the distinction did not show. The model path does not: it
 * self-reports 0.92-0.96 on essentially everything it flags, which collapsed
 * every true positive onto the top two rungs and flattened the ladder the
 * whole design rests on.
 *
 * Mass is the same quantity on both engines - the summed weight of the
 * distinct signal kinds observed - so the two paths stay directly comparable,
 * which is the point of their sharing a signal vocabulary at all. An engine
 * that recovers more of the narrative earns a higher rung by recovering more,
 * not by asserting more.
 *
 * Confidence is kept, but only as a ceiling. It can hold a shaky assessment
 * back off the top rungs; it can no longer push a thin one up onto them.
 */
export function chooseTier(confidence: number, f: Features, signals: Signal[]): 0 | 1 | 2 | 3 | 4 {
  const mass = [...new Set(signals.map((s) => s.kind))].reduce((acc, k) => acc + w(k), 0);
  const big = f.pendingVsMedian >= 8 || (f.pending?.amountCents ?? 0) >= 100000;

  let tier: 0 | 1 | 2 | 3 | 4;
  if (mass < FLAG_THRESHOLD) tier = 0;
  else if (mass < 34) tier = 1;
  else if (mass < 48) tier = big ? 3 : 2;
  else if (mass < 62) tier = 3;
  else tier = big ? 4 : 3;

  // An engine that is genuinely unsure does not get to ask for a co-signature.
  if (confidence < 0.35) tier = Math.min(tier, 1) as 0 | 1;
  else if (confidence < 0.55) tier = Math.min(tier, 2) as 0 | 1 | 2;
  return tier;
}

function money(c: number): string {
  return '$' + (c / 100).toLocaleString('en-US');
}

function plainLanguageOffline(script: ScamScript, signals: Signal[], f: Features): string {
  const top = [...signals].sort((a, b) => w(b.kind) - w(a.kind)).slice(0, 2);
  const reasons = top.map((s) => SIGNAL_LABEL[s.kind]).join(', and ');
  const amt = f.pending ? money(f.pending.amountCents) : 'this payment';
  return [
    'Before ' + amt + ' goes to ' + f.payeeDisplayName + ', one thing worth a second look.',
    'This has the shape of a ' + script.label.toLowerCase() + ' situation - ' + reasons + '.',
    'You can still send it. Nothing is blocked.',
  ].join(' ');
}
