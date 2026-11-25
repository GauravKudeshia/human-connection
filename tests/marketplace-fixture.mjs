import { sqliteD1 } from "./marketplace-db.mjs";
import { createMarketplace } from "../lib/marketplace/store.mjs";
export async function marketplaceFixture({
  hostCount = 2,
  clock = () => 1800000000000,
  quoteFor,
} = {}) {
  const db = sqliteD1(),
    service = createMarketplace(db, { clock, quoteFor });
  const user = async (subject, roles = [], stepUp = false) => {
    const actor = await service.provisionIdentity({
      subject,
      displayName: subject,
      stepUp,
    });
    for (const role of roles)
      await db
        .prepare("INSERT OR IGNORE INTO mp_user_roles VALUES(?,?)")
        .bind(actor.id, role)
        .run();
    await db
      .prepare(
        "INSERT OR IGNORE INTO mp_customer_eligibility VALUES(?,1,1,'beta-2026-11',?)",
      )
      .bind(actor.id, clock())
      .run();
    return actor;
  };
  const customer = await user("test-customer"),
    other = await user("test-other"),
    reviewer = await user("test-reviewer", ["host_reviewer"], true),
    admin = await user("test-admin", ["admin"], true),
    hosts = [];
  const act = (actor, action, payload = {}, key = crypto.randomUUID()) =>
    service.act(actor, action, payload, key);
  for (let i = 0; i < hostCount; i++) {
    const host = await user("test-host-" + i, ["host"]);
    await act(host, "host-submit", {
      displayName: "Fictional fixture " + i,
      biography: "Test only",
      languages: ["English"],
      formats: ["audio", "video"],
      styles: ["funny-stories"],
      adult: true,
      policyVersion: "beta-2026-11",
      trainingVersion: "beta-2026-11",
    });
    await db
      .prepare(
        "INSERT INTO mp_host_verifications VALUES(?,'VERIFIED',?,1,'US','ELIGIBLE',?)",
      )
      .bind(host.id, "fixture-" + i, clock())
      .run();
    await act(reviewer, "host-review", {
      hostId: host.id,
      status: "APPROVED",
      reason: "Local fixture only",
    });
    for (const experience of ["laugh", "hear", "distract"])
      await act(reviewer, "certify", {
        hostId: host.id,
        experience,
        status: "APPROVED",
        rubric: "Local fixture rubric",
        expiresAt: clock() + 86400000,
      });
    await act(host, "heartbeat", { available: true });
    hosts.push(host);
  }
  const choice = {
    experience: "laugh",
    style: "funny-stories",
    duration: 15,
    format: "video",
    language: "English",
  };
  return {
    db,
    service,
    user,
    customer,
    other,
    reviewer,
    admin,
    hosts,
    act,
    choice,
    clock,
  };
}
