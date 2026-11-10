# Build log

A running record of how this project was built, including where APIMatic's
PayPal Context Plugin was used and — just as importantly — where it was not.
Kept live during the build rather than reconstructed afterwards.

Timestamps are Asia/Karachi.

---

## 2026-11-11 02:31 — Project scaffolded

Empty repo, directory structure, MIT license. No code yet.

Toolchain: Node v25.5.0, npm 11.8.0, git 2.50.1.

## 2026-11-11 02:3x — Scam script taxonomy (no plugin involvement)

Wrote `src/scripts/` — the taxonomy of scam scripts, their stages, and the
signals characteristic of each stage. This is domain modelling, not PayPal
integration, so the context plugin has no bearing on it. Recording that
explicitly because the boundary matters for the APIMatic write-up.

## 2026-11-11 03:0x — Offline engine passing 6/6

Wrote `src/engine/features.ts` (deterministic extraction), `offline.ts` (scorer),
`index.ts` (orchestrator), `cli.ts`.

Two real bugs found by running against fixtures rather than by reading code:

1. **Normalisation bias.** `scoreScript` divided matched signal weight by the
   script's own total possible weight. That systematically favoured scripts with
   few stages — the 3-stage "prize" script hit a perfect ratio on two signals and
   beat the 5-stage "romance" script that matched far more evidence. Romance and
   pig-butchering both misclassified as "prize". Fixed by ranking on absolute
   matched mass weighted by inverse document frequency across the script corpus,
   with no per-script normalisation.

2. **Scripts sharing a vocabulary could not be separated.** Grandparent and
   romance share secrecy, urgency, relationship-claim and isolation signals, and
   tied exactly on the early fixture. Added a temporal prior — the grandparent
   script runs in hours, romance takes months — which separates them cleanly.

Result: 6/6 on script identification and stage, including both controls staying
silent. `legit_large` (a $4,200 payment to an 11-day-old payee, the largest in
two years) scores 5 against a threshold of 20 and says nothing, which is the
behaviour the whole design is for.

Known weakness, recorded rather than tuned away: pig-butchering lands at
confidence 0.42 / tier 1 despite $18,000 already lost, because the offline
lexical matcher only recovers 5 of the signals in that narrative. That is the
gap the model path exists to close, and it will be shown as a direct comparison
rather than hidden.

No APIMatic involvement in any of the above — no PayPal API surface touched yet.

