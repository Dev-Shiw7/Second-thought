/**
 * Scam script taxonomy.
 *
 * The central claim of this project: authorized-push-payment fraud against
 * vulnerable adults is not detectable as a numeric anomaly. The payment is
 * authorized, the amount is usually unremarkable, the device and geography are
 * normal. What distinguishes it is the *story* wrapped around it.
 *
 * Scams are not improvised. They run scripts — reproducible narrative arcs with
 * recognizable stages, each stage producing characteristic observable signals and
 * implying a specific next move. Modelling the script, rather than listing rules,
 * is what lets the system say "you are at stage 3 of 5, and here is what happens
 * next" instead of "this transaction is unusual".
 *
 * Sources for the arcs: FTC consumer-protection advisories, FBI IC3 elder-fraud
 * reports, AARP Fraud Watch Network case descriptions, and the FinCEN advisory on
 * elder financial exploitation. Stage structure is our synthesis.
 */

export type ScriptId =
  | 'grandparent'
  | 'romance'
  | 'tech_support'
  | 'government_impersonation'
  | 'pig_butchering'
  | 'prize'
  | 'charity'
  | 'none';

/** Observable signal kinds. These are what the extractor looks for. */
export type SignalKind =
  | 'new_payee'                 // payee first seen very recently
  | 'relationship_claim'        // memo/context asserts a family or romantic tie
  | 'relationship_mismatch'     // claimed close tie, but no prior history
  | 'secrecy_instruction'       // "don't tell"  — highest-signal feature we model
  | 'manufactured_urgency'      // deadline that exists only inside the story
  | 'authority_impersonation'   // IRS, FBI, police, Microsoft, bank fraud dept
  | 'escalation_curve'          // repeated payments, increasing, same new payee
  | 'instrument_steering'       // pushed toward gift cards, crypto, P2P
  | 'reciprocity_absence'       // money flows out only; genuine ties flow both ways
  | 'isolation_language'        // discouraged from consulting bank/family
  | 'overpayment_refund'        // "we refunded too much, send the difference back"
  | 'advance_fee'               // pay a fee to unlock a larger sum
  | 'test_then_scale'           // small successful withdrawal, then a large deposit
  | 'round_number_sequence'     // suspiciously round, repeating amounts
  | 'off_hours'                 // payment at an hour unusual for this person
  | 'velocity_break';           // sudden departure from an established rhythm

export interface Stage {
  n: number;
  name: string;
  /** What you would observe at this stage. */
  signals: SignalKind[];
  /** Plain description of what is happening to the person right now. */
  whatIsHappening: string;
  /**
   * What the script does next. This is the basis of the prediction the system
   * shows the user — the feature that converts disbelief into belief when it
   * comes true.
   */
  nextMove: { within: string; description: string } | null;
}

export interface ScamScript {
  id: ScriptId;
  label: string;
  /** One sentence a non-expert understands. */
  premise: string;
  stages: Stage[];
  /** Typical payment signature, used as a prior during classification. */
  paymentSignature: string;
  /**
   * How old the recipient relationship typically is when money moves, in days.
   * A strong discriminator: the grandparent script runs in hours, romance takes
   * months, and grooming sits in between. Without this prior, scripts that share
   * a signal vocabulary are very hard to separate from the ledger alone.
   */
  expectedPayeeAgeDays: [number, number];
}

export const SCRIPTS: ScamScript[] = [
  {
    id: 'grandparent',
    expectedPayeeAgeDays: [0, 30],
    label: 'Grandparent / family emergency',
    premise:
      'Someone claims a grandchild or other relative is in urgent trouble and needs money immediately and privately.',
    paymentSignature:
      'One moderate payment to a payee created days earlier, followed within a week by larger "fee" payments to the same or a related payee.',
    stages: [
      {
        n: 1,
        name: 'Contact',
        signals: ['relationship_claim', 'new_payee'],
        whatIsHappening:
          'Someone has made contact claiming to be a relative, or someone acting for them such as a lawyer or officer.',
        nextMove: {
          within: 'minutes to hours',
          description:
            'They will describe an emergency — an accident, an arrest, a hospital stay, usually far away — that requires money now.',
        },
      },
      {
        n: 2,
        name: 'Hook',
        signals: ['manufactured_urgency', 'relationship_mismatch'],
        whatIsHappening:
          'An emergency has been described that makes it feel wrong to pause and check.',
        nextMove: {
          within: 'the same conversation',
          description:
            'They will ask you to keep this from the rest of the family — usually framed as protecting someone from worry or embarrassment.',
        },
      },
      {
        n: 3,
        name: 'Secrecy',
        signals: ['secrecy_instruction', 'isolation_language'],
        whatIsHappening:
          'You have been asked to keep this private. This is the step that separates you from the people who would recognise it.',
        nextMove: {
          within: 'hours',
          description:
            'They will request a first payment, and will steer you toward a method that is hard to reverse.',
        },
      },
      {
        n: 4,
        name: 'First payment',
        signals: ['instrument_steering', 'new_payee', 'manufactured_urgency'],
        whatIsHappening: 'A first payment has been requested or sent.',
        nextMove: {
          within: '1 to 3 days',
          description:
            'There will be a second request, larger than the first — court fees, medical costs, or a lawyer’s retainer. If anyone questions it, you will be told not to involve your bank.',
        },
      },
      {
        n: 5,
        name: 'Escalation',
        signals: ['escalation_curve', 'advance_fee', 'isolation_language'],
        whatIsHappening:
          'Further payments are being requested, each justified by a new cost. This continues until the money or the story runs out.',
        nextMove: {
          within: 'days',
          description:
            'Requests will continue to grow and new justifications will keep appearing. No single payment will ever be described as the last one.',
        },
      },
    ],
  },
  {
    id: 'pig_butchering',
    expectedPayeeAgeDays: [14, 240],
    label: 'Investment grooming ("pig butchering")',
    premise:
      'A friendly stranger builds trust over weeks, then introduces an investment platform that shows fake gains.',
    paymentSignature:
      'A long quiet period, one small transfer, a small incoming "withdrawal" that works, then rapidly escalating outbound transfers.',
    stages: [
      {
        n: 1,
        name: 'Warm contact',
        signals: ['new_payee'],
        whatIsHappening:
          'A stranger has made friendly contact, often as a wrong number or a casual social introduction. No money has been mentioned.',
        nextMove: {
          within: 'days to weeks',
          description:
            'They will build rapport without asking for anything. The absence of an ask is itself part of the method.',
        },
      },
      {
        n: 2,
        name: 'Rapport',
        signals: ['relationship_claim'],
        whatIsHappening: 'A sustained friendship or romance has developed.',
        nextMove: {
          within: 'weeks',
          description:
            'They will mention their own investing success and offer to show you the platform they use.',
        },
      },
      {
        n: 3,
        name: 'Test investment',
        signals: ['instrument_steering', 'test_then_scale'],
        whatIsHappening: 'A small first deposit has been made, and it appears to be growing.',
        nextMove: {
          within: 'days',
          description:
            'You will be able to withdraw a small amount successfully. This is deliberate — it is the proof that makes the large deposit feel safe.',
        },
      },
      {
        n: 4,
        name: 'Proof withdrawal',
        signals: ['test_then_scale', 'reciprocity_absence'],
        whatIsHappening:
          'A withdrawal has worked. Confidence is now high, and this is the moment the script is built around.',
        nextMove: {
          within: 'days',
          description:
            'You will be encouraged to deposit a much larger amount, often framed as a limited opportunity.',
        },
      },
      {
        n: 5,
        name: 'Large deposit',
        signals: ['escalation_curve', 'manufactured_urgency', 'round_number_sequence'],
        whatIsHappening: 'A substantially larger sum has been sent.',
        nextMove: {
          within: 'days to weeks',
          description:
            'When you try to withdraw, the withdrawal will fail and a tax, fee, or compliance payment will be demanded before the funds can be released. That payment will not release them.',
        },
      },
      {
        n: 6,
        name: 'Exit fee',
        signals: ['advance_fee', 'isolation_language'],
        whatIsHappening:
          'Money is being requested in order to retrieve money. The invested funds do not exist to be returned.',
        nextMove: {
          within: 'ongoing',
          description:
            'Further fees will be demanded for as long as you keep paying them.',
        },
      },
    ],
  },
  {
    id: 'romance',
    expectedPayeeAgeDays: [30, 500],
    label: 'Romance',
    premise:
      'An online partner who never manages to meet in person develops escalating emergencies that require money.',
    paymentSignature:
      'Small regular outbound transfers over months to a single payee, never reciprocated, growing after each crisis.',
    stages: [
      {
        n: 1,
        name: 'Idealisation',
        signals: ['new_payee', 'relationship_claim'],
        whatIsHappening:
          'An intense online relationship has formed quickly, with strong declarations early.',
        nextMove: {
          within: 'weeks',
          description:
            'Plans to meet will be made and then fall through for reasons outside their control.',
        },
      },
      {
        n: 2,
        name: 'Future-faking',
        signals: ['relationship_mismatch', 'reciprocity_absence'],
        whatIsHappening:
          'A shared future is being discussed, but an in-person meeting has not happened.',
        nextMove: {
          within: 'weeks',
          description:
            'A first crisis will arrive — a medical bill, a customs fee, a blocked account — with a modest request attached.',
        },
      },
      {
        n: 3,
        name: 'First crisis',
        signals: ['manufactured_urgency', 'instrument_steering'],
        whatIsHappening: 'A first request for money has been made, framed as temporary.',
        nextMove: {
          within: 'weeks',
          description:
            'Repayment will be promised and will not arrive. A second, larger crisis will follow.',
        },
      },
      {
        n: 4,
        name: 'Escalation',
        signals: ['escalation_curve', 'reciprocity_absence'],
        whatIsHappening:
          'Requests are recurring and growing. Nothing has ever been repaid.',
        nextMove: {
          within: 'ongoing',
          description:
            'If family or friends raise concerns, you will be encouraged to see them as jealous or interfering.',
        },
      },
      {
        n: 5,
        name: 'Isolation',
        signals: ['isolation_language', 'secrecy_instruction'],
        whatIsHappening:
          'The relationship is being positioned against the people who are worried about you.',
        nextMove: {
          within: 'ongoing',
          description:
            'Contact with people who question the relationship will be discouraged further.',
        },
      },
    ],
  },
  {
    id: 'tech_support',
    expectedPayeeAgeDays: [0, 7],
    label: 'Tech support / refund',
    premise:
      'A warning claims your computer or account is compromised; "support" then engineers a refund error you must repay.',
    paymentSignature:
      'An unusual payment shortly after a remote-access session, often an odd non-round amount mirroring a fake refund.',
    stages: [
      {
        n: 1,
        name: 'Alarm',
        signals: ['authority_impersonation', 'manufactured_urgency'],
        whatIsHappening:
          'A pop-up, call, or email has claimed your device or account is compromised and gave you a number to call.',
        nextMove: {
          within: 'the same session',
          description:
            'You will be asked to install software that lets them control your screen.',
        },
      },
      {
        n: 2,
        name: 'Remote access',
        signals: ['authority_impersonation'],
        whatIsHappening:
          'Someone has remote control of your device and can show you anything they like on it.',
        nextMove: {
          within: 'the same session',
          description:
            'They will show you a refund that appears too large, and claim they made an error you must correct.',
        },
      },
      {
        n: 3,
        name: 'Fake overpayment',
        signals: ['overpayment_refund', 'manufactured_urgency'],
        whatIsHappening:
          'You are being shown a balance that was never really credited, and asked to return the difference.',
        nextMove: {
          within: 'minutes',
          description:
            'You will be asked to send the difference back, often by gift card or transfer, and told their job depends on it.',
        },
      },
      {
        n: 4,
        name: 'Repayment',
        signals: ['instrument_steering', 'off_hours'],
        whatIsHappening: 'Real money is being sent to correct an error that did not occur.',
        nextMove: {
          within: 'days',
          description:
            'They will contact you again, as the same company or a different one offering to recover your loss.',
        },
      },
    ],
  },
  {
    id: 'government_impersonation',
    expectedPayeeAgeDays: [0, 14],
    label: 'Government or bank impersonation',
    premise:
      'A caller posing as a government agency or your bank’s fraud team demands immediate payment to avoid arrest or loss of benefits.',
    paymentSignature:
      'A single large payment under time pressure, in an instrument no government agency actually uses.',
    stages: [
      {
        n: 1,
        name: 'Threat',
        signals: ['authority_impersonation', 'manufactured_urgency'],
        whatIsHappening:
          'You have been told there is a warrant, an investigation, a suspended benefit, or a compromised account.',
        nextMove: {
          within: 'the same call',
          description:
            'They will ask you to confirm personal details to "verify" you, and will insist you stay on the line.',
        },
      },
      {
        n: 2,
        name: 'Verification',
        signals: ['isolation_language'],
        whatIsHappening:
          'You are being kept on the phone and discouraged from hanging up to check.',
        nextMove: {
          within: 'the same call',
          description:
            'They will demand payment by gift card, wire, crypto, or transfer to a "safe account". No real agency does this.',
        },
      },
      {
        n: 3,
        name: 'Payment demand',
        signals: ['instrument_steering', 'manufactured_urgency', 'new_payee'],
        whatIsHappening:
          'An urgent payment is being demanded in a form that cannot be reversed.',
        nextMove: {
          within: 'hours to days',
          description:
            'If you pay, a second agency or officer will contact you about a further problem.',
        },
      },
    ],
  },
  {
    id: 'prize',
    expectedPayeeAgeDays: [0, 60],
    label: 'Prize or lottery',
    premise:
      'You have supposedly won something, but a fee must be paid before it can be released.',
    paymentSignature: 'Repeating modest round-number payments to newly created payees.',
    stages: [
      {
        n: 1,
        name: 'Win notice',
        signals: ['new_payee', 'manufactured_urgency'],
        whatIsHappening: 'You have been told you won a prize, often one you did not enter for.',
        nextMove: {
          within: 'days',
          description:
            'A fee, tax, or shipping cost will be required before the prize can be released.',
        },
      },
      {
        n: 2,
        name: 'Advance fee',
        signals: ['advance_fee', 'round_number_sequence'],
        whatIsHappening: 'You are being asked to pay in order to receive.',
        nextMove: {
          within: 'days',
          description:
            'After the first fee is paid, another will be discovered. The prize will not arrive.',
        },
      },
      {
        n: 3,
        name: 'Repeat fees',
        signals: ['escalation_curve', 'advance_fee'],
        whatIsHappening: 'Fees are repeating under new names.',
        nextMove: {
          within: 'ongoing',
          description: 'This continues for as long as payments continue.',
        },
      },
    ],
  },
  {
    id: 'charity',
    expectedPayeeAgeDays: [0, 30],
    label: 'Charity / disaster appeal',
    premise:
      'An urgent appeal, often following a real disaster, pressures an immediate irreversible donation.',
    paymentSignature:
      'An out-of-pattern donation to a newly created payee shortly after a news event.',
    stages: [
      {
        n: 1,
        name: 'Appeal',
        signals: ['manufactured_urgency', 'new_payee'],
        whatIsHappening:
          'An emotionally urgent appeal has arrived, tied to a recent event.',
        nextMove: {
          within: 'the same conversation',
          description:
            'You will be pushed to give immediately by a method that cannot be traced or refunded.',
        },
      },
      {
        n: 2,
        name: 'Pressure',
        signals: ['instrument_steering', 'manufactured_urgency'],
        whatIsHappening: 'Pressure is being applied to give right now rather than check first.',
        nextMove: {
          within: 'weeks',
          description:
            'Your details will be reused for further appeals, and may be sold on to other operations.',
        },
      },
    ],
  },
];

export const SCRIPTS_BY_ID: Record<string, ScamScript> = Object.fromEntries(
  SCRIPTS.map((s) => [s.id, s]),
);

/** Human-readable weight of each signal, used for explanation and for the offline scorer. */
export const SIGNAL_WEIGHT: Record<SignalKind, number> = {
  secrecy_instruction: 10,
  isolation_language: 9,
  authority_impersonation: 8,
  overpayment_refund: 8,
  relationship_mismatch: 7,
  instrument_steering: 7,
  advance_fee: 7,
  escalation_curve: 6,
  test_then_scale: 6,
  manufactured_urgency: 5,
  reciprocity_absence: 5,
  new_payee: 3,
  relationship_claim: 3,
  round_number_sequence: 2,
  velocity_break: 2,
  off_hours: 1,
};

export const SIGNAL_LABEL: Record<SignalKind, string> = {
  secrecy_instruction: 'asked to keep it secret',
  isolation_language: 'discouraged from checking with others',
  authority_impersonation: 'someone claiming official authority',
  overpayment_refund: 'a refund error you are asked to repay',
  relationship_mismatch: 'claims a close relationship with no shared history',
  instrument_steering: 'pushed toward a payment that cannot be undone',
  advance_fee: 'asked to pay in order to receive',
  escalation_curve: 'payments growing to the same new recipient',
  test_then_scale: 'a small success followed by a much larger request',
  manufactured_urgency: 'a deadline that only exists in their story',
  reciprocity_absence: 'money has only ever gone one way',
  new_payee: 'a recipient added very recently',
  relationship_claim: 'a claimed family or romantic connection',
  round_number_sequence: 'repeating round-number amounts',
  velocity_break: 'a sharp break from your usual pattern',
  off_hours: 'sent at an unusual hour for you',
};
