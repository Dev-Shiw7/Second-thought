# Two-minute demo script

The short version. One story, start to finish. No feature tour.

## Before you record

1. Run the fixtures once to check your Groq quota isn't spent:
   `npm run classify -- grandparent` — if it says `[engine: llm]` you're fine.
   If it says `[engine: offline]`, the demo still works, just don't claim the
   AI is running.
2. `npm start`
3. Open `http://localhost:3000/?theme=light` and load the **grandparent**
   scenario. Force the theme so your laptop doesn't switch to dark mid-take.
4. Let the page finish loading before you hit record. Never show a cold load.

---

## 0:00 – 0:20 — Start with the payment, not the product

Point at the pending payment: **$3,800 to R. Alvarez Legal Services.**

> "This is a real-looking payment. Her phone, her house, her bank, and she
> approved it herself. Every fraud system in the world looks at this and sees
> nothing wrong, because nothing is wrong with the payment.
>
> What's wrong is that this morning someone phoned her, said her grandson was
> in jail in Mexico, and told her not to tell his mother."

Stop there for a second. That line is the whole idea.

---

## 0:20 – 0:40 — Show the pattern

Point at the timeline: **$1,200 → $2,400 → $3,800**, all to one person she
didn't know nine days ago.

> "You can see the shape here. The payments are climbing, they're all round
> numbers, they all go one way, and the recipient didn't exist last week."

---

## 0:40 – 1:05 — Show the two lines that matter

Point at the top two rows of the evidence table:

- **asked to keep it secret** — "please don't tell Mom, she would never forgive him"
- **discouraged from checking with others** — "I should not discuss the case with my bank"

> "These two are the real signal. Their only job is to cut her off from the
> people who'd spot this straight away. No system that looks at amounts can see
> them, because they aren't in the amount — they're in what she was told."

---

## 1:05 – 1:35 — Show the prediction

Switch to her screen. Read the message out loud, then point at the prediction.

> "It doesn't tell her she's being scammed. That never works, because the
> scammer already told her the bank would say exactly that.
>
> Instead it tells her what he's going to do next: ask for more money, and tell
> her not to involve her bank. When that happens, she believes it. He can't warn
> her about something that hasn't happened yet."

Say clearly: **the payment is not blocked.** Her daughter gets a message. That's
all.

---

## 1:35 – 1:55 — The control. Don't skip this one.

Switch to the **legit_large** scenario.

> "Same system, different payment. $4,200 to someone she met eleven days ago —
> the biggest payment in two years, round number, brand new recipient. On paper
> this looks worse than the scam.
>
> It's a roof repair. And it stays completely silent."

> "That's the part I care about. A system that shouts at every big payment is
> useless, because she'll switch it off by Thursday."

---

## 1:55 – 2:00 — Close

> "It reads the story around the payment, not the number. And it never takes the
> decision away from her."

---

## If someone asks what doesn't work

Answer straight, it reads better than dodging:

- No live PayPal — PayPal doesn't operate in Pakistan, so there's no sandbox
  account. The integration is tested against PayPal's documented format instead.
- The AI's confidence scores aren't calibrated and it's written up as an open
  problem.
- Six test cases, written by me. That's a demo, not an evaluation.
