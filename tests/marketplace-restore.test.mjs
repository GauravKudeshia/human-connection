import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteD1 } from "./marketplace-db.mjs";
test("a quiesced SQLite backup restores authoritative ownership, roles and active claims", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "hc-restore-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const source = join(folder, "source.sqlite"),
    restored = join(folder, "restored.sqlite");
  const db = sqliteD1(source),
    now = Date.now();
  db.sqlite
    .prepare(
      "INSERT INTO mp_users(id,provider_subject,display_name,created_at) VALUES('customer','subject-c','Test customer',?),('host','subject-h','Test host',?)",
    )
    .run(now, now);
  db.sqlite.exec(
    "INSERT INTO mp_user_roles VALUES('customer','customer'),('host','host')",
  );
  db.sqlite
    .prepare(
      "INSERT INTO mp_bookings(id,customer_id,host_id,request_key,fingerprint,experience,duration,format,language,quote,amount_cents,currency,status,expires_at,created_at,updated_at) VALUES('booking','customer','host','request','digest','laugh',15,'video','English','{}',1000,'USD','ACCEPTED',?,?,?)",
    )
    .run(now + 180000, now, now);
  db.sqlite
    .prepare("INSERT INTO mp_host_claims VALUES('host','customer','booking',?)")
    .run(now + 180000);
  db.close();
  await copyFile(source, restored);
  const recovered = sqliteD1(restored);
  t.after(() => recovered.close());
  assert.equal(
    recovered.sqlite.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.equal(
    recovered.sqlite.prepare("PRAGMA foreign_key_check").all().length,
    0,
  );
  assert.equal(
    recovered.sqlite.prepare("SELECT customer_id FROM mp_host_claims").get()
      .customer_id,
    "customer",
  );
  assert.equal(
    recovered.sqlite
      .prepare("SELECT role FROM mp_user_roles WHERE user_id='host'")
      .get().role,
    "host",
  );
  assert.throws(
    () =>
      recovered.sqlite
        .prepare(
          "INSERT INTO mp_host_claims VALUES('host','customer','booking',?)",
        )
        .run(now + 180000),
    /UNIQUE/,
  );
});
