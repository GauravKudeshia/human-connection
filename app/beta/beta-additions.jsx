"use client";
import Image from "next/image";
import React, { useRef, useState } from "react";
import { useResource } from "./beta-panels";
import { human, money } from "./beta-api.mjs";

export function VisitConsent({ request = fetch, onChange }) {
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function change(next) {
    setBusy(true);
    setError("");
    try {
      const response = await request("/api/marketplace/visitor", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          next
            ? { action: "start", consent: true, consentVersion: "analytics-v1" }
            : { action: "forget" },
        ),
      });
      const body = await response.json();
      if (!response.ok)
        throw Error(
          body.error?.message || "Visit preferences could not be saved.",
        );
      setEnabled(next);
      onChange(next);
    } catch (issue) {
      setError(issue.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="beta-visit-consent">
      <label className="beta-checkbox">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => change(e.target.checked)}
        />
        Allow optional measurement of this visit and experience selection
      </label>
      <p className="beta-small">
        Off by default. A random visit token lasts up to 24 hours; records
        expire after 31 days. It is not linked to your account. Uncheck to erase
        this visit.
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function HostQuality({ api, revision }) {
  const { data, error } = useResource(api, "host-quality", null, revision);
  return (
    <section className="beta-card">
      <h2>Your hosting quality</h2>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <dl className="beta-metrics">
            <div>
              <dt>Delivered sessions</dt>
              <dd>{data.delivered || 0}</dd>
            </div>
            <div>
              <dt>Accepted requests</dt>
              <dd>
                {data.accepted || 0} / {data.requests || 0}
              </dd>
            </div>
            <div>
              <dt>Public rating</dt>
              <dd>
                {data.ratings
                  ? `${Number(data.averageRating).toFixed(1)} / 5 from ${data.ratings} ratings`
                  : "No delivered ratings yet"}
              </dd>
            </div>
            <div>
              <dt>Worth it</dt>
              <dd>
                {data.valueYes || 0} yes / {data.valueAnswers || 0} answered
              </dd>
            </div>
            <div>
              <dt>Service exceptions</dt>
              <dd>{data.serviceExceptions || 0}</dd>
            </div>
          </dl>
          <p className="beta-small">{data.definitions?.value}</p>
          {data.certifications?.map((c) => (
            <p key={c.experience}>
              {human(c.experience)} · {human(c.status)} · Review by{" "}
              {new Date(c.expires_at).toLocaleDateString()}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
export function ProfilePhotoUpload({ api, revision, request = fetch }) {
  const { data: photos } = useResource(api, "my-photos", null, revision);
  const [alt, setAlt] = useState(""),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const pending = useRef(null);
  async function upload(event) {
    event.preventDefault();
    const file = event.currentTarget.elements.photo.files[0];
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      if (file.type !== "image/png" || file.size > 1048576)
        throw Error("Choose a PNG photo up to 1 MiB and 2048 × 2048 pixels.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      const body = JSON.stringify({
        kind: "photo",
        base64: btoa(binary),
        altText: alt,
        consent,
      });
      if (pending.current?.body !== body)
        pending.current = { body, key: crypto.randomUUID() };
      const response = await request("/api/marketplace/media", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": pending.current.key,
        },
        body,
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error?.message || "Photo upload failed.");
      pending.current = null;
      setNotice(
        "Photo uploaded for review. It becomes visible after approval.",
      );
    } catch (issue) {
      setError(issue.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="beta-card">
      <h2>Your profile photo</h2>
      <p>
        Use a photo you are authorized to publish. PNG only, up to 1 MiB and
        2048 × 2048 pixels. Image metadata is removed.
      </p>
      {photos?.[0] && <p>Latest photo · {human(photos[0].status)}</p>}
      <form onSubmit={upload}>
        <label>
          Photo
          <input name="photo" type="file" accept="image/png" required />
        </label>
        <label>
          Accessible photo description
          <input
            maxLength={160}
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            required
          />
        </label>
        <label className="beta-checkbox">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          I authorize publication of this photo.
        </label>
        <button
          className="beta-secondary"
          disabled={busy || !consent || !alt.trim()}
        >
          {busy ? "Uploading…" : "Submit photo for review"}
        </button>
      </form>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function PrivacyAccount({ api }) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState(null),
    [error, setError] = useState("");
  return (
    <section className="beta-card">
      <h1>Your account and privacy</h1>
      <p>
        Closing your account immediately signs you out and removes hosting
        availability. Private data erasure follows the reviewed retention
        policy. Financial, policy and safety evidence may need to be retained.
        External provider account deletion is a separate operation.
      </p>
      <label className="beta-checkbox">
        <input
          type="checkbox"
          checked={confirm}
          onChange={(e) => setConfirm(e.target.checked)}
        />
        I understand that access closes immediately and want to request account
        erasure.
      </label>
      <button
        className="beta-danger"
        disabled={!confirm || busy || !!result}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const closed = await api.act("privacy-request", { confirm: true });
            setResult(closed);
          } catch (issue) {
            setError(issue.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Close account and request erasure
      </button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div role="status">
          <h2>Account access closed</h2>
          <p>
            {human(result.status)}. Keep this private receipt token to check
            your request:
          </p>
          <code className="beta-wrap">
            {result.receiptToken ||
              "Use the receipt already issued for this request."}
          </code>
          <p>{result.preservedEvidence}</p>
        </div>
      )}
    </section>
  );
}
export function TransferWorkspace({ data, run, busy }) {
  const [hostId, setHostId] = useState(""),
    [reason, setReason] = useState("");
  return (
    <section className="beta-card">
      <h2>Sandbox host transfers</h2>
      <p>
        Transfers allocate test funds to a connected test account. Bank payouts
        remain unavailable. A different finance reviewer must approve each
        transfer.
      </p>
      {!data.enabled && (
        <p className="beta-notice">
          Sandbox transfers are disabled. A reviewed test destination and
          separate test-transfer configuration are required.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(
            "transfer-request",
            { hostId, reason },
            "Sandbox transfer requested for independent review.",
          );
        }}
      >
        <label>
          Host account ID
          <input
            value={hostId}
            onChange={(e) => setHostId(e.target.value)}
            required
          />
        </label>
        <label>
          Review explanation
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            required
          />
        </label>
        <button
          className="beta-secondary"
          disabled={busy || !data.enabled || !hostId.trim() || !reason.trim()}
        >
          Request sandbox transfer
        </button>
      </form>
      {data.batches?.map((b) => (
        <article className="beta-card" key={b.id}>
          <p>
            {money(b.amountCents)} · {human(b.status)} · {b.hostId}
          </p>
          <div className="beta-actions">
            {b.status === "REQUESTED" && (
              <button
                disabled={busy || !data.enabled}
                onClick={() =>
                  run(
                    "transfer-approve",
                    { batchId: b.id },
                    "Sandbox transfer reviewed.",
                  )
                }
              >
                Approve as second reviewer
              </button>
            )}
            {["APPROVED", "FAILED"].includes(b.status) && (
              <button
                disabled={busy || !data.enabled}
                onClick={() =>
                  run(
                    "transfer-dispatch",
                    { batchId: b.id },
                    "Test transfer submitted for reconciliation.",
                  )
                }
              >
                Submit test transfer
              </button>
            )}
            {["SUBMITTED", "RECONCILED"].includes(b.status) && (
              <button
                disabled={busy || !data.enabled}
                onClick={() =>
                  run(
                    "transfer-reconcile",
                    { batchId: b.id },
                    "Test transfer reconciled.",
                  )
                }
              >
                Reconcile provider reference
              </button>
            )}
            {["REQUESTED", "APPROVED"].includes(b.status) && (
              <button
                disabled={busy}
                onClick={() =>
                  run(
                    "transfer-cancel",
                    { batchId: b.id },
                    "Unsubmitted test transfer cancelled.",
                  )
                }
              >
                Cancel unsubmitted transfer
              </button>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}
export function PhotoReview({ record, run, busy }) {
  const [reason, setReason] = useState("");
  return (
    <article className="beta-card">
      <h2>Profile photo review</h2>
      <Image
        unoptimized
        width={160}
        height={160}
        className="beta-profile-photo"
        src={
          "/api/marketplace/media?kind=photo&id=" +
          encodeURIComponent(record.id)
        }
        alt={record.alt_text}
      />
      <p>Host · {record.host_id}</p>
      <label>
        Review explanation
        <textarea
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <div className="beta-actions">
        {["APPROVED", "REJECTED"].map((status) => (
          <button
            key={status}
            disabled={busy || !reason.trim()}
            onClick={() =>
              run(
                "photo-review",
                { photoId: record.id, status, reason },
                "Photo review saved.",
              )
            }
          >
            {human(status)}
          </button>
        ))}
      </div>
    </article>
  );
}
export function PrivacyReview({ record, run, busy }) {
  const [reason, setReason] = useState(""),
    [holdId, setHoldId] = useState("");
  return (
    <article className="beta-card">
      <h2>Account erasure request</h2>
      <p>
        {human(record.status)} ·{" "}
        {record.wait_reason || "No recorded hold reason"} · {record.holds}{" "}
        active holds
      </p>
      <p className="beta-small">Request reference {record.id}</p>
      <label>
        Retention decision explanation
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
        />
      </label>
      <div className="beta-actions">
        <button
          disabled={busy || !reason.trim() || record.status === "COMPLETED"}
          onClick={() =>
            run(
              "privacy-hold",
              { requestId: record.id, action: "PLACE", scope: "ALL", reason },
              "Retention hold recorded.",
            )
          }
        >
          Place reviewed retention hold
        </button>
        <button
          disabled={busy || record.status !== "FAILED"}
          onClick={() =>
            run(
              "privacy-retry",
              { requestId: record.id, reason },
              "Erasure request queued for reviewed processing.",
            )
          }
        >
          Retry processing
        </button>
      </div>
      {record.holdsDetails?.map((hold) => (
        <p className="beta-small beta-wrap" key={hold.id}>
          Active {human(hold.scope)} hold · {hold.id}
        </p>
      ))}
      <label>
        Hold reference to release
        <input value={holdId} onChange={(e) => setHoldId(e.target.value)} />
      </label>
      <button
        disabled={busy || !holdId.trim() || !reason.trim()}
        onClick={() =>
          run(
            "privacy-hold",
            { requestId: record.id, holdId, action: "RELEASE", reason },
            "Retention hold released.",
          )
        }
      >
        Release reviewed hold
      </button>
    </article>
  );
}
export function ClosureReceipt({ request = fetch }) {
  const [token, setToken] = useState(""),
    [status, setStatus] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <details className="beta-visit-consent">
      <summary>Check an account erasure receipt</summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const response = await request("/api/marketplace/privacy-receipt", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ receiptToken: token }),
            });
            const body = await response.json();
            if (!response.ok)
              throw Error(body.error?.message || "Receipt unavailable.");
            setStatus(body.data);
          } catch (issue) {
            setError(issue.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Private receipt token
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            maxLength={128}
          />
        </label>
        <button className="beta-secondary" disabled={busy || !token}>
          Check request
        </button>
      </form>
      {status && (
        <p role="status">
          {human(status.status)} ·{" "}
          {status.waiting
            ? "Processing awaits a reviewed policy or retention requirement."
            : "Request recorded."}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
