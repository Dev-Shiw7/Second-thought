# What the PayPal context plugin actually changed

Three concrete things, each traceable to a specific skill. Recorded at the time,
not reconstructed.

## 1. It corrected an assumption about error payload casing

`typescript-error-handling` states that an error payload keeps the spec's own
field names and is **not** camelCased like a model:

> An error payload's members keep the spec's own field names — they are not
> camelCased like a model's. […] a payload documenting an underscored or dotted
> field is read at that exact spelling — `err.result?.some_field`, never
> `err.result?.someField`.

Verified against the SDK source. `dist/esm/types/errors/searchError.d.ts`:

    debug_id: string;
    information_link?: string;
    total_items?: number;
    maximum_items?: number;

Every other model in this SDK is camelCase. Written from memory, this code would
have read `err.result.debugId` and silently got `undefined` on every error path —
the kind of bug that only shows up when something is already going wrong.

## 2. It told us which classes Transaction Search actually throws — and we
## then misread our own evidence

The skill says do not guess from the operation name, and read the
`throwOn(...)` / `defaultToError(...)` lines **in the operation's method body**.
The original grep did not scope to a method:

    $ grep -oE "throwOn\([0-9]+, [A-Za-z]+|defaultToError\([A-Za-z]+" \
        node_modules/@paypal/paypal-server-sdk/dist/cjs/controllers/transactionSearchController.js

    defaultToError(defaultError
    defaultToError(searchError
    throwOn(400, defaultError
    throwOn(403, defaultError
    throwOn(500, defaultError

Those five lines come from **two different operations** in the same controller,
and we recorded the union of them as Transaction Search's mapping. Reading the
method bodies, which is what the skill actually said to do:

- `searchTransactions` declares **no `throwOn` lines at all** — only
  `defaultToError(SearchError)`. Every non-2xx from Transaction Search is a
  `SearchError`.
- The `throwOn(400|403|500, DefaultError)` lines belong to `searchBalances`, a
  different operation.

Corrected in `src/paypal/ingest.ts`, and pinned by a test in
`src/paypal/verify-ingest.ts` that stubs a 400 and asserts the concrete class.
Recording the mistake rather than quietly fixing it, because the skill was right
and the shortcut was not: a file-wide grep cannot answer a per-operation
question.

### 2b. And `result` is not populated here at all

The same correction has a sharper consequence that only showed when the code was
finally executed. `ApiError.result` is filled by `loadResult(error)`, and the
core request builder calls that on **one** path only — the loop over error types
registered with `throwOn(status, Class)`:

    const error = new errorConstructor(context, ...args);
    if (errorConstructor.prototype instanceof ApiError) {
      await loadResult(error);      // <- only here
    }
    throw error;

The default path (`_addResponseValidator`) constructs the error from
`defaultToError(...)` and throws it without parsing anything. Since
`searchTransactions` registers no statuses, **`err.result` is always `undefined`
for this operation**, however typed the class is. The payload is on `err.body`,
as a raw string.

That silently disabled finding 3 below for a year of imagined runtime: see
there.

## 3. It surfaced a real bug — RESULTSET_TOO_LARGE

This is the one that justifies the plugin on its own.

`SearchError`'s payload carries `total_items` and `maximum_items`, documented in
the SDK source as "Valid only for `RESULTSET_TOO_LARGE`". That is PayPal telling
you a window returned more transactions than it will serve, and how many it
found.

The first version of `fetchHistory` caught every error identically and `break`ed
out of the window. On a busy month that would have silently dropped **an entire
month out of the 24-month baseline**. Every behavioural signal in this project —
"31× their normal rate", "49× their median payment" — is measured against that
baseline. A hole in it does not announce itself; it just makes every ratio
quietly wrong, in the direction of under-reacting.

`src/paypal/ingest.ts` now bisects the window and recurses on that specific
error, and distinguishes 404 (no activity in the window, normal across a 24-month
walk) from real failures.

### What this entry originally got wrong

The bisect was written as `err.result?.name === 'RESULTSET_TOO_LARGE'`. Per 2b,
`result` is never populated for this operation, so that test could never be
true, the bisect could never fire, and the too-large window was dropped exactly
as before — the bug this entry claims to have fixed, still present, now with a
branch above it that looked like a fix.

Nothing detected this, because the fix and the bug fail identically: a dropped
window produces no error, only a baseline with a hole in it. It was found by
writing `src/paypal/verify-ingest.ts` and watching the bisect assertion fail.
The payload is now read from `err.body`, and the test pins both halves: that the
typed error arrives with `result` undefined, and that the body carries
`total_items` at the wire spelling.

The honest version of this entry is therefore narrower than it was, and more
useful: the plugin pointed at the right failure, and the code written from that
pointer still did not work until it was run.

## Where the boundary is

Being precise about this reads as credibility, not weakness.

- The plugin informed **PayPal SDK usage only**: client construction, controller
  selection, error handling, and the ingest retry logic.
- It had **no bearing** on the scam-script taxonomy, the feature extractor, the
  offline scorer, the classification approach, the model prompt, or the console.
  Those are domain and product work, and claiming otherwise would be dishonest.
- The PayPal Server SDK is itself APIMatic-generated — its source headers say
  `This file was automatically generated by APIMATIC v3.0`. That is *why* the
  plugin can state the client shape, controller naming and error types exactly
  rather than inferring them from REST documentation.
