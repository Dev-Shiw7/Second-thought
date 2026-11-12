/**
 * Model path. Runs on Groq.
 *
 * The model is NOT asked to be clever with raw data. It receives exact facts
 * already computed by `features.ts` - payee age, escalation curve, reciprocity,
 * amount ratios - and is told not to recompute them. What it is asked for is
 * the part that is irreducibly linguistic: whether a request for discretion is
 * ordinary privacy or secrecy coaching, whether a deadline is real or
 * manufactured, and which script the whole shape fits.
 *
 * The taxonomy is a stable prefix: it leads the system message so Groq's
 * automatic prefix caching can reuse it; only the per-account facts vary.
 *
 * The answer shape is pinned by a JSON schema derived from the same zod schema
 * that validates the reply, so a malformed answer fails here rather than
 * downstream. Groq enforces the schema server-side in strict mode; the zod
 * parse is the second line of defence.
 */
import Groq from 'groq-sdk';
import { z } from 'zod';
import { SCRIPTS, SIGNAL_WEIGHT, SIGNAL_LABEL } from '../scripts/taxonomy.ts';
import type { ScriptId, SignalKind } from '../scripts/taxonomy.ts';
import type { Account, Assessment, Signal } from '../types.ts';
import type { Features } from './features.ts';
import { chooseTier } from './offline.ts';

// `||`, not `??`: .env.example ships the override present but empty.
const MODEL = process.env.SECOND_THOUGHT_MODEL || 'openai/gpt-oss-120b';

/** Only the gpt-oss family on Groq accepts a reasoning effort knob. */
const SUPPORTS_EFFORT = MODEL.startsWith('openai/gpt-oss');

const SIGNAL_KINDS = Object.keys(SIGNAL_WEIGHT) as [SignalKind, ...SignalKind[]];
const SCRIPT_IDS = ['none', ...SCRIPTS.map((s) => s.id)] as unknown as [string, ...string[]];

const AssessmentSchema = z.object({
  script: z.enum(SCRIPT_IDS).describe('Which scam script best fits, or "none".'),
  stage: z.number().describe('Stage number within that script, or 0 for none.'),
  confidence: z.number().describe('0 to 1. Be honest; 0.5 means genuinely unsure.'),
  signals: z
    .array(
      z.object({
        kind: z.enum(SIGNAL_KINDS),
        evidence: z.string().describe('Short quote or fact supporting this signal.'),
      }),
    )
    .describe('Only signals you can point to evidence for.'),
  predictedNextMoves: z
    .array(
      z.object({
        within: z.string().describe('e.g. "hours", "1 to 3 days", "the same call".'),
        description: z
          .string()
          .describe('What the other party will do next, stated concretely and checkably.'),
        confidence: z.number(),
      }),
    )
    .describe('Empty when script is "none".'),
  plainLanguage: z
    .string()
    .describe('What is shown to the person. Empty string when script is "none".'),
  uncertainty: z.string().describe('What would change your mind. For the console, not the person.'),
});

function taxonomyBrief(): string {
  const lines: string[] = [];
  lines.push('SCAM SCRIPTS AND THEIR STAGES\n');
  for (const s of SCRIPTS) {
    lines.push(`### ${s.id} - ${s.label}`);
    lines.push(s.premise);
    lines.push(`Payment signature: ${s.paymentSignature}`);
    lines.push(
      `Relationship is typically ${s.expectedPayeeAgeDays[0]}-${s.expectedPayeeAgeDays[1]} days old when money moves.`,
    );
    for (const st of s.stages) {
      lines.push(
        `  ${st.n}. ${st.name} - ${st.whatIsHappening}` +
          (st.nextMove ? ` NEXT (${st.nextMove.within}): ${st.nextMove.description}` : ''),
      );
    }
    lines.push('');
  }
  lines.push('SIGNAL VOCABULARY (use only these kinds)\n');
  for (const k of SIGNAL_KINDS) {
    lines.push(`- ${k}: ${SIGNAL_LABEL[k]}`);
  }
  return lines.join('\n');
}

const SYSTEM_INSTRUCTIONS = `You assess whether a pending payment is part of a scam that the account holder has been talked into. This is authorized-push-payment fraud: the person genuinely intends to send the money. Numeric fraud checks cannot see it, because nothing about the amount or the device is wrong. What distinguishes it is the story around the payment.

Your job is to decide which scam script, if any, the evidence fits, and at what stage.

HOW TO BE RIGHT

- A large, round, unfamiliar payment is not suspicious by itself. People buy roofs and settle invoices. If there is no narrative evidence - no secrecy, no manufactured urgency, no impersonated authority, no coached isolation - return "none" no matter how big the number is. Returning "none" when the ledger looks dramatic but the story is innocent is a correct and important answer, not a missed catch.
- Weigh secrecy and isolation most heavily. "Don't tell your daughter" and "don't discuss this with your bank" are the signals that separate fraud from an ordinary private transaction, because their only function is to remove the person from the people who would recognise what is happening.
- Distinguish ordinary discretion from coaching. "Don't mention the surprise party" is privacy. "Don't tell your family about this payment, they'll be angry with you" is isolation being engineered.
- Use the relationship-age prior. The grandparent script runs in hours; romance takes months. When two scripts share a vocabulary, the age of the relationship usually separates them.
- Do not recompute arithmetic. Payee age, escalation sequences, reciprocity and amount ratios are given to you as exact computed facts. Use them. Never contradict them.

PREDICTION

When a script fits, predict what the other party does next, drawn from the stage model. Be concrete and checkable - a prediction the person can recognise when it happens, like "they will tell you not to discuss this with your bank". A prediction that comes true is far more persuasive than a warning, because the person has usually been pre-armed against warnings by the scammer.

WRITING FOR THE PERSON

plainLanguage is read by an adult who is not a fool and is not a child, possibly at a stressful moment, possibly in large type.

- Short sentences. No jargon, no risk scores, no "our systems have detected".
- Never imply they are gullible, confused, or declining. Name what the other party is doing, not what is wrong with them.
- Say plainly that the payment is not blocked and they can still send it. This is true and it matters: they keep authority over their own money.
- Three or four sentences at most.
- If script is "none", return an empty string. Say nothing rather than something mild.`;

export async function assessWithModel(
  acct: Account,
  f: Features,
  priorSignals: Signal[],
): Promise<Assessment> {
  // High reasoning effort over a long taxonomy prompt runs past the SDK's
  // 60s default often enough to matter; a timeout here costs the whole model
  // path and silently drops back to the weaker offline scorer.
  const client = new Groq({ timeout: 180_000, maxRetries: 2 });

  const facts = [
    `Account holder: ${acct.personName}, age band ${acct.personAgeBand}.`,
    `Trusted contact on file: ${acct.trustedContact ? `${acct.trustedContact.name} (${acct.trustedContact.relationship})` : 'none'}.`,
    '',
    'PENDING PAYMENT',
    f.pending
      ? `$${(f.pending.amountCents / 100).toLocaleString('en-US')} to "${f.payeeDisplayName}", memo: "${f.pending.memo}", instrument: ${f.pending.instrument}, at ${f.pending.ts}.`
      : 'none',
    '',
    'EXACT COMPUTED FACTS (do not recompute)',
    `- Recipient first seen: ${f.payeeAgeDays} day(s) before this payment.`,
    `- Recipient is an established contact: ${f.payeeEstablished}.`,
    `- Claimed relationship: ${f.claimedRelationship ?? 'none asserted'}.`,
    `- Prior payments to this recipient: ${f.priorOutboundCount}, totalling $${(f.priorOutboundCents / 100).toLocaleString('en-US')}.`,
    `- Ever received money back from them: $${(f.inboundFromPayeeCents / 100).toLocaleString('en-US')}.`,
    `- Outbound sequence to this recipient: ${f.amountSequence.map((c) => '$' + (c / 100).toLocaleString('en-US')).join(' -> ')}.`,
    `- Strictly escalating: ${f.strictlyEscalating}.`,
    `- This payment is ${f.pendingVsMedian.toFixed(1)}x the person's median payment and ${f.pendingVsPriorMax.toFixed(2)}x their largest in 24 months.`,
    `- Outbound value in the last 14 days is ${f.recentVelocityMultiple.toFixed(1)}x their normal rate.`,
    `- Payment instrument is unusual for them: ${f.instrumentUnusual}.`,
    `- Initiated at hour ${f.localHour} UTC. Outside usual hours: ${f.offHours}.`,
    '',
    'SIGNALS ALREADY DETECTED STRUCTURALLY (confirm or override)',
    priorSignals.length
      ? priorSignals.map((s) => `- ${s.kind}: ${s.evidence}`).join('\n')
      : '- none',
    '',
    'WHAT THE PERSON HAS SAID OR RECEIVED',
    acct.notes.length
      ? acct.notes.map((n) => `[${n.ts}] (${n.source}) ${n.text}`).join('\n')
      : '- nothing recorded',
  ].join('\n');

  const schema = z.toJSONSchema(AssessmentSchema) as Record<string, unknown>;
  delete schema.$schema;

  const response = await client.chat.completions.create({
    model: MODEL,
    max_completion_tokens: 16000,
    temperature: 0,
    ...(SUPPORTS_EFFORT ? { reasoning_effort: 'high' as const } : {}),
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'assessment', strict: true, schema },
    },
    messages: [
      { role: 'system', content: SYSTEM_INSTRUCTIONS + '\n\n' + taxonomyBrief() },
      { role: 'user', content: facts },
    ],
  });

  const choice = response.choices[0];
  if (!choice) {
    throw new Error('model returned no choices');
  }
  if (choice.finish_reason === 'length') {
    throw new Error('model output was truncated before the assessment was complete');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(choice.message.content ?? '');
  } catch {
    throw new Error('structured output was not valid JSON');
  }
  // A refusal arrives as schema-shaped JSON that fails this parse, or as a
  // thrown APIError above; either way the caller falls back to the offline scorer.
  const result = AssessmentSchema.safeParse(raw);
  if (!result.success) {
    throw new Error('structured output did not match the schema: ' + result.error.message);
  }
  const parsed = result.data;

  const script = SCRIPTS.find((s) => s.id === parsed.script);
  const stageDef = script?.stages.find((st) => st.n === parsed.stage);
  const isNone = parsed.script === 'none';
  // The model's own signals, not the structural ones it was shown: the tier is
  // earned by what this engine actually recovered from the narrative.
  const modelSignals: Signal[] = parsed.signals.map((s) => ({
    kind: s.kind as SignalKind,
    evidence: s.evidence,
  }));

  return {
    script: parsed.script as ScriptId,
    scriptLabel: script?.label ?? 'No script detected',
    stage: isNone ? 0 : parsed.stage,
    stageCount: script?.stages.length ?? 0,
    stageName: stageDef?.name ?? '-',
    confidence: Math.max(0, Math.min(1, parsed.confidence)),
    signals: modelSignals,
    predictedNextMoves: parsed.predictedNextMoves,
    tier: isNone ? 0 : chooseTier(parsed.confidence, f, modelSignals),
    plainLanguage: isNone ? '' : parsed.plainLanguage,
    uncertainty: parsed.uncertainty,
    engine: 'llm',
  };
}
