/**
 * Demo server.
 *
 * Serves the two-pane console and the assessment API. The two panes are the
 * whole point of the demo: the person's screen and the trusted contact's
 * console, side by side, so you can watch one event land in both places.
 */
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import 'dotenv/config';
import { assess, loadAccount, extract } from './engine/index.ts';
import { SIGNAL_LABEL, SIGNAL_WEIGHT } from './scripts/taxonomy.ts';
import { applyWebhook, WATCHED_EVENTS, type PayPalWebhookEvent } from './paypal/adapter.ts';
import { readPayPalEnv, makeClient } from './paypal/client.ts';
import { verifyWebhook } from './paypal/verify-webhook.ts';
import type { Account } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '../fixtures');
const WEB = join(HERE, '../web');

const app = express();
/**
 * Capture the exact bytes PayPal sent. Signature verification is computed over
 * the raw body - re-serialising the parsed object changes key order and
 * whitespace, and the signature will not match.
 */
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }),
);
app.use(express.static(WEB));

const TIER_NAME = [
  'Silent log',
  'Inline note',
  'Cooling-off offered',
  'Trusted contact notified',
  'Co-sign requested',
];

function listFixtures(): string[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

/** Everything the UI needs to render one assessment, in one payload. */
async function buildView(acct: Account, forceOffline: boolean) {
  const a = await assess(acct, { forceOffline });
  const f = extract(acct);
  const pending = f.pending;
  const payee = pending ? acct.payees.find((p) => p.id === pending.payeeId) ?? null : null;

  // The series the timeline draws: every movement with this recipient.
  const series = pending
    ? acct.transactions
        .filter((t) => t.payeeId === pending.payeeId)
        .map((t) => ({
          id: t.id,
          ts: t.ts,
          amount: t.amountCents / 100,
          direction: t.direction,
          memo: t.memo,
          status: t.status,
        }))
    : [];

  return {
    person: { name: acct.personName, ageBand: acct.personAgeBand },
    trustedContact: acct.trustedContact,
    pending: pending
      ? {
          id: pending.id,
          amount: pending.amountCents / 100,
          currency: pending.currency,
          memo: pending.memo,
          instrument: pending.instrument,
          ts: pending.ts,
          payeeName: payee?.displayName ?? 'Unknown',
          payeeEmail: payee?.email ?? '',
        }
      : null,
    facts: {
      payeeAgeDays: f.payeeAgeDays,
      payeeEstablished: f.payeeEstablished,
      claimedRelationship: f.claimedRelationship,
      priorOutboundCount: f.priorOutboundCount,
      priorOutbound: f.priorOutboundCents / 100,
      inboundFromPayee: f.inboundFromPayeeCents / 100,
      amountSequence: f.amountSequence.map((c) => c / 100),
      strictlyEscalating: f.strictlyEscalating,
      medianOutbound: f.medianOutboundCents / 100,
      pendingVsMedian: f.pendingVsMedian,
      pendingVsPriorMax: f.pendingVsPriorMax,
      recentVelocityMultiple: f.recentVelocityMultiple,
      instrumentUnusual: f.instrumentUnusual,
    },
    series,
    notes: acct.notes,
    assessment: {
      ...a,
      tierName: TIER_NAME[a.tier],
      signals: a.signals.map((s) => ({
        ...s,
        label: SIGNAL_LABEL[s.kind] ?? s.kind,
        weight: SIGNAL_WEIGHT[s.kind] ?? 0,
      })),
    },
    groundTruth: acct._groundTruth ?? null,
  };
}

app.get('/api/scenarios', (_req, res) => {
  const out = listFixtures().map((name) => {
    const acct = loadAccount(join(FIXTURES, name + '.json'));
    const pending = acct.transactions.find((t) => t.status === 'pending');
    return {
      name,
      label: name.replace(/_/g, ' '),
      pendingAmount: pending ? pending.amountCents / 100 : null,
      expected: acct._groundTruth?.script ?? null,
      isControl: acct._groundTruth?.script === 'none',
    };
  });
  res.json(out);
});

app.get('/api/assess/:name', async (req, res) => {
  const name = String(req.params.name).replace(/[^a-z0-9_]/gi, '');
  if (!listFixtures().includes(name)) {
    res.status(404).json({ error: 'no such scenario' });
    return;
  }
  const forceOffline = req.query.offline === '1' || !process.env.GROQ_API_KEY;
  try {
    const acct = loadAccount(join(FIXTURES, name + '.json'));
    res.json(await buildView(acct, forceOffline));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * PayPal webhook receiver - the real-time trigger.
 *
 * Signature verification runs whenever PayPal credentials and a webhook id are
 * configured. Without them the endpoint runs UNVERIFIED so the demo works on a
 * clean checkout, and says so loudly on every request rather than failing
 * silently - an unverified endpoint accepts forged events from anyone, and that
 * is a property a reviewer should see, not discover.
 */
app.post('/api/webhook', async (req, res) => {
  const env = readPayPalEnv();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (env && webhookId) {
    const raw = (req as express.Request & { rawBody?: string }).rawBody ?? '';
    try {
      const outcome = await verifyWebhook(
        makeClient(env),
        env,
        req.headers as Record<string, string>,
        raw,
        webhookId,
      );
      if (!outcome.verified) {
        console.warn('[webhook] rejected: ' + outcome.reason);
        res.status(401).json({ error: 'signature verification failed', reason: outcome.reason });
        return;
      }
    } catch (err) {
      // Fail closed. An error verifying is not permission to proceed.
      console.warn('[webhook] verification error: ' + (err instanceof Error ? err.message : String(err)));
      res.status(503).json({ error: 'could not verify signature' });
      return;
    }
  } else {
    console.warn(
      '[webhook] UNVERIFIED - no PAYPAL_CLIENT_ID/PAYPAL_WEBHOOK_ID configured. ' +
        'Demo mode only; this endpoint would accept forged events.',
    );
  }
  const signatureVerified = Boolean(env && webhookId);

  const event = req.body as PayPalWebhookEvent;
  if (!event?.event_type || !WATCHED_EVENTS.has(event.event_type)) {
    res.json({ ignored: true, reason: 'event type not watched' });
    return;
  }
  const base = String(req.query.account ?? 'clean').replace(/[^a-z0-9_]/gi, '');
  if (!listFixtures().includes(base)) {
    res.status(400).json({ error: 'unknown base account' });
    return;
  }
  const acct = applyWebhook(loadAccount(join(FIXTURES, base + '.json')), event);
  const view = await buildView(acct, !process.env.GROQ_API_KEY);
  res.json({ ...view, signatureVerified });
});

app.get('/api/health', (_req, res) => {
  const verifying = Boolean(readPayPalEnv() && process.env.PAYPAL_WEBHOOK_ID);
  res.json({
    ok: true,
    // Key presence, not reachability: a quota-exhausted or rate-limited key
    // still reports configured, and the request then falls back to the offline
    // scorer. The console badges the engine each assessment actually used.
    engine: process.env.GROQ_API_KEY
      ? 'model path configured - falls back to the offline scorer on any error'
      : 'offline only',
    paypal: process.env.PAYPAL_CLIENT_ID ? 'credentials present' : 'no credentials',
    webhookSignatureVerification: verifying
      ? 'enabled'
      : 'DISABLED - set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID to enable',
    scenarios: listFixtures().length,
  });
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log('Second Thought running at http://localhost:' + PORT);
  console.log(
    '  engine: ' + (process.env.GROQ_API_KEY ? 'model path available' : 'offline scorer (no GROQ_API_KEY)'),
  );
});
