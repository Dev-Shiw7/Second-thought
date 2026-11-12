# Second Thought

**Payments that read the story, not the number.**

A $500 payment to someone you met four days ago looks completely normal to a
fraud system. The amount is unremarkable, the device is yours, the location is
yours, and you authorised it yourself — because you were told your grandson had
been arrested and needed bail by five o'clock, and you were told not to tell his
mother.

That last part is the whole thing. Authorized-push-payment fraud against older
adults is invisible to numeric fraud detection by construction: nothing about the
transaction is wrong. What is wrong is the story wrapped around it, and a story
is a language problem.

Second Thought reads that story.

---

## What it actually does

It models scams as **scripts** — reproducible narrative arcs with recognisable
stages — rather than as a list of red-flag rules. Seven scripts, twenty-four
stages, sixteen signal kinds. Given a pending payment plus the conversation
around it, it answers three questions:

1. **Which script is running?** Grandparent emergency, romance, tech-support
   refund, government impersonation, investment grooming, prize, charity.
2. **What stage is it at?** Stage 3 of 5 is "you have just been asked to keep
   this secret". Stage 5 is "the requests have started growing".
3. **What happens next?** This is the part that matters most.

### The prediction is the point

Telling someone they are being defrauded almost never works. The scammer got
there first and has already inoculated them against exactly that challenge —
"the bank will try to stop you, they don't understand."

So Second Thought doesn't warn. It **predicts**:

> This matches the grandparent scam. You're at stage 3 of 5. If this is what I
> think it is, within the next day they'll tell you not to discuss this with your
> bank, and the next amount they ask for will be larger than this one.

When that prediction comes true — and it does, because the script is a script —
belief flips in an instant. A warning asks to be trusted. A prediction earns it.

### It never blocks anything

Five graduated tiers: silent log → an inline note → a cooling-off offer →
notifying a pre-designated trusted contact → asking that contact to co-sign.
**Every tier is overridable. Nothing is ever hard-blocked.**

The person sets this up for themselves, in advance, while well. That makes it a
self-binding commitment — a Ulysses contract — not a guardianship. They keep
authority over their own money, which is both the ethical design and the better
product: an override that always works is what makes a false positive cheap. The
worst case at tier one is a mildly annoying sentence.

---

## Run it

No API key required. No PayPal credentials required. Everything below works on a
clean checkout.

```bash
npm install
npm run seed       # generate the six fixtures
npm test           # engine regression + PayPal adapter round-trip
npm start          # http://localhost:3000
```

Node 20+. For the model path and live PayPal calls, copy `.env.example` to
`.env` and fill it in — but the demo does not need either.

### What you'll see

Two panes, side by side: the person's screen on the left, the trusted contact's
console on the right, so you can watch one event land in both places.

Six scenarios in the picker. **Start with `grandparent`** (the default), then —
and this matters more than it looks — **look at the two controls**:

| Scenario | What it proves |
|---|---|
| `grandparent` | Primary demo. Three escalating payments, intercepted at the third. |
| `grandparent_early` | The good outcome: caught at the secrecy stage, before any money moves. |
| `romance` | A months-long arc; the trusted contact has already raised concerns. |
| `pig_butchering` | Investment grooming, caught at the exit-fee stage. |
| **`clean`** | **Control.** An ordinary month. The system says nothing. |
| **`legit_large`** | **Control.** $4,200 to an 11-day-old payee — the largest payment in two years, round number, new recipient. Numerically the most alarming transaction in any fixture. **It is a roof repair, and the system stays silent.** |

`legit_large` is the one to look at hardest. Any amount-based system flags it.
Ours scores it 5 against a reporting threshold of 20 and says nothing, because
there is no story — no secrecy, no manufactured urgency, no impersonated
authority. That contrast *is* the thesis.

---

## How it works

```
PayPal Transaction Search ──► 24-month behavioural baseline
                                      │
PayPal webhook ──► pending payment ───┤
                                      ▼
                          deterministic feature extraction
                      (payee age, escalation curve, reciprocity,
                       amount ratios, velocity — exact, never guessed)
                                      │
                                      ▼
                    ┌─────────────────┴─────────────────┐
                    │                                   │
           model path (Groq)                 offline scorer
      narrative + intent classification    lexical + structural only
                    │                                   │
                    └─────────────────┬─────────────────┘
                                      ▼
                        script + stage + prediction + tier
```

### The division of labour is deliberate

Anything computable from the ledger is **computed**, exactly, and never asked of
a language model: payee age, escalation sequences, reciprocity, amount ratios
against the person's own baseline, hour-of-day. The model is handed those as
fixed facts and told not to recompute them.

What the model is asked is the part that is irreducibly linguistic:

- Is this secrecy coaching, or an ordinary request for discretion? ("Don't
  mention the surprise party" is privacy. "Don't tell your family, they'll be
  angry with you" is isolation being engineered.)
- Is this deadline real, or does it exist only inside the story?
- Which script does the whole shape fit?

That split is why this isn't an LLM wrapper. The arithmetic is arithmetic; the
judgment is judgment.

### Two engines, honestly compared

| | Model path | Offline scorer |
|---|---|---|
| Needs a key | yes | **no** |
| Script identification on fixtures | **6/6** | **6/6** |
| Stage accuracy on fixtures | 5/6 *(see below)* | **6/6** |
| Reads intent | yes | no — lexical matching only |
| Deterministic | no | yes |

The offline scorer exists so judges can run this, and so the regression tests are
reproducible. It is genuinely weaker where it matters, and it does not pretend
otherwise: on `pig_butchering` it lands at confidence 0.42 and tier 1 despite
$18,000 already being gone, because its lexical matcher recovers only 5 of the
signals in that narrative. The model path is what closes that gap.

---

## PayPal integration

Built on `@paypal/paypal-server-sdk@2.5.0` — Orders, Payments, Subscriptions,
Transaction Search and Vault. (Notably: that SDK is itself generated by APIMatic;
its source headers say so.)

**Two ingestion paths, kept separate on purpose:**

- **Transaction Search builds the history.** It is the only way to get a
  behavioural baseline, and the baseline is what makes "31× their normal rate"
  mean anything. PayPal documents a reporting lag of up to three hours, so it can
  never be the trigger.
- **Webhooks are the trigger.** An assessment that arrives three hours after the
  money left isn't an intervention, it's a receipt.

`npm run verify:paypal` renders every fixture into PayPal's exact Transaction
Search wire shape, reads it back through the production adapter, and asserts the
assessment is unchanged. **6/6 — 921 transactions, 47 payees, no drift.** It
needs no credentials, so you can run it right now.

That test exists for one specific failure mode: PayPal's `account_id` is absent
on many card and guest flows, so payee identity falls back to email and then to
display name. Get that wrong and one recipient fragments into several, which
silently destroys the escalation and reciprocity signals — both are computed per
payee. The test deliberately strips `account_id` from half the payees to exercise
the fallback chain.

`npm run verify:ingest` covers the layer above it: window width, the backward
month-by-month walk, paging, the bisect when PayPal says a window returned more
than it will serve, that the two halves meet with no gap, the recursion floor,
404 as an empty window rather than a failure, and which error class the
operation actually throws. It drives the real SDK through a stub transport
(`unstable_httpClientOptions`), so it also runs with no credentials. **15/15.**

Writing it found two bugs that no amount of reading had:

- **The SDK does not return PayPal's JSON.** It deserializes into its own
  camelCase model — `transactionDetails`, `totalPages` — and the ingestion code
  was reading `transaction_details` and `total_pages`. Against the live API
  every page would have counted as empty, nothing past page one would ever be
  fetched, and the pages handed on were in a shape the adapter cannot read. The
  baseline would have come back empty, with no error anywhere. The round-trip
  test above could not catch it, because it feeds the adapter wire-shaped
  fixtures directly and so never sees what the SDK does to them.
- **`err.result` is never populated for this operation.** The SDK parses an
  error body only for errors registered with `throwOn(status, Class)`;
  `searchTransactions` registers none. So the `RESULTSET_TOO_LARGE` bisect,
  which tested `err.result?.name`, could never fire — the window it exists to
  rescue was being dropped exactly as it was before the branch was written. The
  payload lives on `err.body`.

Both failed silently. Neither would have been caught by a live sandbox either:
an account with no transaction history exercises no windowing, no paging and no
error branch.

`npm run verify:failclosed` covers the webhook signature path's failure modes —
each missing header refused without PayPal being called at all, an unparseable
body, a `FAILURE` verdict, a missing `verification_status`, a 5xx from the
verify call, and a dead network. The assertion in every case is that nothing
reports verified. **11/11.**

---

## What is not done

Stated plainly, because a reviewer will find these anyway and because pretending
otherwise would be worse than the gaps.

- **Webhook signature verification is implemented but inactive by default.** It
  calls PayPal's `verify-webhook-signature` over the raw request bytes and fails
  closed — a verification error is not permission to proceed. It only runs when
  `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_WEBHOOK_ID` are all set.
  Without them the endpoint runs **unverified** so the demo works on a clean
  checkout, and says so on every request (`signatureVerified: false`) and in
  `/api/health`. It has never been exercised against a real signed delivery,
  and in this environment it cannot be: PayPal does not operate in Pakistan, so
  there are no sandbox credentials to get. Verification is a call asking PayPal
  whether PayPal signed something; there is no offline equivalent. What is
  tested is every way that call can fail to come back clean —
  `npm run verify:failclosed`, 11/11 — because an endpoint that reads "I could
  not check" as "it is fine" accepts forged events from anyone.
- **The model path has now been run end to end, on six fixtures, once.** On
  Groq (`openai/gpt-oss-120b`, reasoning effort high) it identifies all six
  scripts correctly, including both controls — `clean` and `legit_large` come
  back `none` at 0.94–0.96 confidence, which is the result that matters most.
  It disagrees with one fixture's expected stage: `grandparent_early` is
  labelled stage 4 (first payment) where the fixture says stage 3 (secrecy).
  Six fixtures written by the same people who wrote the taxonomy is not an
  accuracy measurement, and confidence values clustered at 0.96 are a model
  being agreeable, not a model being calibrated. The offline scorer is still
  what the regression tests assert against.
- **A single webhook is not enough on its own.** A realistic event — $2,400, new
  payee, memo "urgent bail for Tommy, please do not tell mom" — scores 19 against
  a threshold of 20 and stays silent. Four signals fire from a memo; twelve fire
  once conversation history is present. We left the threshold alone rather than
  tune it to make a demo work. The companion-app context is load-bearing.
- **The context notes are supplied, not captured.** Where the conversation
  actually comes from — a companion app, forwarded SMS, a call transcript — is a
  consent and product problem this doesn't solve.
- **Fixtures are synthetic.** The scam arcs are built from FTC, FBI IC3, AARP and
  FinCEN descriptions of real scripts, but no real victim data was used.
- **No auth, no multi-tenancy, no persistence.** It is a demo server.

---

## Privacy and dignity

The trusted contact sees flagged payments and the evidence behind them. They do
**not** get a window into the person's whole financial life — the disclosure is
scoped to what triggered it. The ladder escalates to a person, not to an
institution. And the person who set it up can turn it off, override any tier, and
send any payment they like.

An intervention that strips someone's autonomy to protect their money has
traded away the thing worth protecting.

---

## License

MIT — see [LICENSE](LICENSE).

Built for the PayPal AI Hackathon 2026. Development log, including where the
APIMatic context plugin was and was not used, is in [BUILD-LOG.md](BUILD-LOG.md).
