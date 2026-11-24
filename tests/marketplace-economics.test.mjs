import assert from "node:assert/strict";
import test from "node:test";
import { estimateContribution } from "../lib/marketplace/economics.mjs";

test("the scenario estimate charges a third participant's media cost without increasing price or host share", () => {
  const input = {
    priceCents: 1000,
    minutes: 15,
    processorBasisPoints: 300,
    processorFixedCents: 30,
    mediaMicrosPerParticipantMinute: 10000,
    supportCents: 20,
    expectedRefundAndCreditLossCents: 25,
    allocatedAcquisitionCents: 40,
  };
  const pair = estimateContribution(input);
  const friend = estimateContribution({ ...input, participants: 3 });
  assert.equal(pair.hostCents, 700);
  assert.equal(pair.processorCents, 60);
  assert.equal(pair.contributionBeforeAcquisitionCents, 165);
  assert.equal(pair.contributionCents, 125);
  assert.equal(friend.contributionCents, pair.contributionCents - 15);
  assert.equal(friend.hostCents, pair.hostCents);
  assert.equal(friend.priceCents, pair.priceCents);
});

test("assumptions validate integer units and keep a negative contribution visible", () => {
  assert.throws(() => estimateContribution({ priceCents: 1000, minutes: 15, participants: 4 }), /participants/);
  assert.throws(() => estimateContribution({ priceCents: 10.01, minutes: 15 }), /priceCents/);
  assert.equal(
    estimateContribution({ priceCents: 1000, minutes: 15, supportCents: 500 }).contributionCents,
    -200,
  );
});
