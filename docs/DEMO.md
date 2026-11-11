# Three-minute demo script

Judges are not required to watch past 3:00. Every judge interviewed about
hackathon judging said the same two things: **lead with the problem until the
audience shares your frustration with it**, and **if the demo runs long that is
not a pacing problem, it is a scope problem — cut.**

One flow, end to end. Not a feature tour.

Setup before recording: `npm start`, open `http://localhost:3000/?theme=light`
(forcing the theme means the OS setting can't surprise you mid-take), and have
the `grandparent` scenario loaded. Pre-load the page. Never let a cold fetch
happen on camera.

---

## 0:00–0:25 — The problem

Do not open on the product. Open on the $500.

> "This payment is five hundred dollars, to someone she met four days ago. Her
> device. Her location. She authorised it herself. Every fraud system on earth
> looks at this and sees nothing wrong — because nothing *is* wrong with the
> payment.
>
> What's wrong is that an hour earlier, someone told her her grandson had been
> arrested, and told her not to tell his mother."

Land that last clause. It is the entire thesis and it takes four seconds.

---

## 0:25–0:35 — What it is

> "Second Thought reads the story around a payment instead of the number. It
> knows scams run scripts — and it can tell you which one you're in, and what
> happens next."

---

## 0:35–2:00 — The flow

**Show the ledger first (0:35–0:50).** `grandparent` scenario, console pane.
Point at the escalation: $1,200 → $2,400 → $3,800, nine days, one recipient who
didn't exist before that.

> "A rules engine can see this shape. What it can't see is why."

**Show the evidence table (0:50–1:10).** Top two rows, sorted by weight:

- *asked to keep it secret* — "please don't tell Mom, she would never forgive him"
- *discouraged from checking with others* — "I should not discuss the case with my bank"

> "These two are the whole game. Their only function is to separate her from the
> people who'd recognise this. No amount-based system can see them, because
> they're not in the amount."

**Show the person's screen (1:10–1:35).** Read the plain-language text aloud.
Then point at the prediction box.

> "It doesn't warn her. Warnings don't work — the scammer already told her the
> bank would try to stop her. It *predicts*: the next ask will be bigger, and
> they'll tell her not to talk to her bank. When that happens tomorrow, she'll
> believe the app instead of the voice on the phone."

**Show the override (1:35–1:45).** Click "Send $3,800 anyway". Let it go through.

> "And she can still send it. Nothing is ever blocked. She set this up for
> herself while she was well — it's a commitment, not a guardian."

**Now the control (1:45–2:00).** Switch to `legit_large`. This is the beat that
wins the argument.

> "Same person. Forty-two hundred dollars — her largest payment in two years,
> round number, a payee who's eleven days old. Numerically this is far more
> alarming than the scam. It's a roof repair. Watch."

Show the silent pane.

> "Nothing. Because there's no story. That's the difference between reading the
> number and reading the narrative."

---

## 2:00–2:30 — That it's real

Terminal, pre-run so output is already on screen:

```
npm test
```

> "Six scenarios, script and stage, both controls silent. And this —"

Point at the adapter round-trip.

> "— renders every fixture into PayPal's exact Transaction Search wire format,
> reads it back through the production adapter, and checks the assessment
> survives. Nine hundred transactions, forty-seven payees, no drift. Runs with no
> credentials, so you can check it yourself."

---

## 2:30–2:50 — Architecture and what's missing

One slide, three lines:

- Transaction Search builds the baseline. Webhooks are the trigger. An
  assessment three hours late is a receipt, not an intervention.
- The arithmetic is computed exactly and never asked of a model. The model is
  only asked the thing that's actually linguistic — is this secrecy coaching, or
  ordinary privacy?
- **Say what isn't done.** The model path isn't executed end to end. Webhook
  signature verification is implemented and fails closed, but has never seen a
  real signed delivery. And a webhook alone scores 19 against a threshold of 20 —
  we left the threshold alone rather than tune it to make this demo work.

That last bullet is not a weakness to bury. Judges can tell when you're talking
around a feature that doesn't exist, and being straight about it reads as
confidence.

---

## 2:50–3:00 — Close

> "Eighty-odd teams in this hackathon built machinery to bound what an AI agent
> is allowed to spend. We pointed the same idea at the people who actually get
> defrauded."

---

## Recording notes

- **Pre-fill everything.** One cold API call or rate-limit on camera kills the take.
- **Force the theme** with `?theme=light`. Don't let dark mode surprise you.
- **Don't narrate the UI** ("here I click the dropdown"). Narrate the argument.
- Upload to YouTube, public, under 3:00. No copyrighted music.
- The written submission must say which AI models were used and how — that's a
  stated requirement, not a nice-to-have.
