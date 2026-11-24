# Marketplace unit economics

The demo retains $10 for 15 minutes and $18 for 30 minutes. The local sandbox supports authoritative snapshots and a configurable 70% base host allocation. Tips are tracked separately. Actual merchant, tax, settlement and bank payout decisions require approval. [Provider decisions](PROVIDER-INTEGRATION-DECISIONS.md)

The [estimator](../scripts/estimate-marketplace.mjs) reads a JSON file with one scenario or an array of scenarios. Run `node scripts/estimate-marketplace.mjs assumptions.json`. Its inputs are hypotheses and the script never calls a payment or media provider.

```json
[
  {
    "priceCents": 1000,
    "minutes": 15,
    "participants": 2,
    "hostShareBasisPoints": 7000,
    "processorBasisPoints": 300,
    "processorFixedCents": 30,
    "mediaMicrosPerParticipantMinute": 10000,
    "supportCents": 20,
    "expectedRefundAndCreditLossCents": 25,
    "allocatedAcquisitionCents": 40
  },
  {
    "priceCents": 1000,
    "minutes": 15,
    "participants": 3,
    "hostShareBasisPoints": 7000,
    "processorBasisPoints": 300,
    "processorFixedCents": 30,
    "mediaMicrosPerParticipantMinute": 10000,
    "supportCents": 20,
    "expectedRefundAndCreditLossCents": 25,
    "allocatedAcquisitionCents": 40
  }
]
```

Use cents for flat amounts, basis points for rates, and millionths of a dollar for media cost per participant-minute. Set expected refund and credit loss after recoveries. The estimator subtracts host compensation, processing, media, support, and that net loss from payment. It reports contribution before and after allocating acquisition cost. Fixed overhead, taxes, provider-specific settlement schedules, and variance across actual sessions require separate analysis.

The illustrative pair yields $1.25 after allocated acquisition cost. Three participants for the whole 15-minute session reduce the estimate to $1.10 at the same price and host pay. The three-person scenario is an upper-bound media duration when a guest joins after the start. Raise the support assumption or the attributable refund/credit loss to model extra moderation or a less successful session. Request a 30-minute comparison by setting price to 1800 and minutes to 30.

Use reconciled capture, refund, processor fees, host pay and consumed media minutes in an approved pilot. For consented referrals, measure incremental bookings and realized costs before ascribing value to invitations. A modeled contribution is an estimate before fixed overhead.
