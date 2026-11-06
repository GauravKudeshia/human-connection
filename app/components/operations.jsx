"use client";
import React from "react";
import { ShieldCheck, Lock, Receipt, Users, BookOpen } from "lucide-react";
import { hosts, money } from "../../lib/catalog.mjs";
import { Empty, human, date } from "./shared";
export default function Operations({ s, tab, act, busy, setModal }) {
  return (
    <>
      {tab === "overview" && (
        <>
          <div className="stats-grid">
            {[
              [
                "Active sessions",
                s.bookings.filter((b) =>
                  ["LIVE", "RECONNECTING"].includes(b.status),
                ).length,
              ],
              [
                "Open safety cases",
                s.reports.filter((r) => r.status !== "CLOSED").length,
              ],
              [
                "Refund reviews",
                s.refunds.filter((r) => r.status === "OPEN").length,
              ],
              [
                "Journal balance",
                money(
                  s.journals
                    .flatMap((j) => j.lines)
                    .reduce((a, l) => a + l.debit - l.credit, 0),
                ),
              ],
            ].map(([t, v]) => (
              <div className="stat" key={t}>
                <span>{t}</span>
                <strong>{v}</strong>
                <small>This fictional workspace</small>
              </div>
            ))}
          </div>
          <div className="panel">
            <h2>Service controls</h2>
            <p className="muted">
              Turning either control off prevents new checkouts and ends active
              demo calls with a review.
            </p>
            {[
              [
                "staffed",
                "Safety coverage available",
                "Simulated staffing signal. No actual safety operator is on duty.",
              ],
              [
                "providerHealthy",
                "Call provider healthy",
                "Simulated provider status. Live video is not integrated.",
              ],
            ].map(([key, title, note]) => (
              <div className="setting-row" key={key}>
                <span>
                  <strong>{title}</strong>
                  <small>{note}</small>
                </span>
                <button
                  className={`toggle ${s.operations[key] ? "on" : ""}`}
                  role="switch"
                  aria-label={title}
                  aria-checked={s.operations[key]}
                  onClick={() =>
                    act("operations", {
                      setting: key,
                      value: !s.operations[key],
                    })
                  }
                  disabled={busy}
                >
                  <span />
                  {s.operations[key] ? "On" : "Off"}
                </button>
              </div>
            ))}
          </div>
          <div className="panel">
            <h2>Live launch stays closed</h2>
            <p className="muted">
              This build accepts no real money and issues no video-provider
              tokens.
            </p>
            <div className="gate-grid">
              {[
                "Payment provider eligibility",
                "Identity & age verification",
                "Approved refund and tax policies",
                "Staffed safety response",
                "LiveKit integration & signed webhooks",
                "Production RBAC & PostgreSQL migrations",
                "Accessibility & security review",
                "Reconciliation & backup drills",
              ].map((t) => (
                <div key={t}>
                  <Lock size={16} />
                  {t}
                  <span>Pending</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {tab === "safety" && (
        <div className="panel">
          <h2>Safety cases</h2>
          <p className="muted">
            Demo case records only. Reports here do not notify a real operator.
          </p>
          {!s.reports.length ? (
            <Empty icon={ShieldCheck} title="No open conversations to review">
              Use Report on a host or in the demo room to try this workflow.
            </Empty>
          ) : (
            s.reports.map((r) => (
              <div className="case-card" key={r.id}>
                <div>
                  <span className={`status ${r.urgent ? "alert" : ""}`}>
                    {r.urgent ? "Urgent · " : ""}
                    {human(r.status)}
                  </span>
                  <small>
                    {date(r.createdAt)} · {r.id.slice(0, 8)}
                  </small>
                </div>
                <h3>{hosts.find((h) => h.id === r.hostId)?.name}</h3>
                <p>{r.reason}</p>
                {r.note && <p className="muted">Operator note: {r.note}</p>}
                <div className="button-row">
                  {["ASSIGNED", "ESCALATED", "CLOSED"]
                    .filter((x) => x !== r.status)
                    .map((status) => (
                      <button
                        className="secondary"
                        key={status}
                        onClick={() =>
                          setModal({
                            type: "reason",
                            title: `${human(status)} case`,
                            label: "Audit reason",
                            submit: (reason) =>
                              act(
                                "case-action",
                                { caseId: r.id, status, reason },
                                "Case updated.",
                              ),
                          })
                        }
                      >
                        {human(status)}
                      </button>
                    ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}
      {tab === "refunds" && (
        <div className="panel">
          <h2>Refund reviews</h2>
          {!s.refunds.length ? (
            <Empty icon={Receipt} title="Nothing waiting for review">
              Refund requests and interrupted demo calls appear here.
            </Empty>
          ) : (
            s.refunds.map((r) => {
              const b = s.bookings.find((b) => b.id === r.bookingId);
              return (
                <div className="case-card" key={r.id}>
                  <span className="status">{human(r.status)}</span>
                  <h3>
                    {hosts.find((h) => h.id === b.hostId)?.name} ·{" "}
                    {money(b.totalCents)}
                  </h3>
                  <p>{r.reason}</p>
                  {r.status === "OPEN" && (
                    <button
                      className="primary"
                      onClick={() =>
                        setModal({
                          type: "reason",
                          title: "Resolve with a demo refund",
                          label: "Audit reason",
                          submit: (reason) =>
                            act(
                              "refund-resolve",
                              { refundId: r.id, reason },
                              "Demo refund recorded with a compensating journal.",
                            ),
                        })
                      }
                    >
                      Approve demo refund
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
      {tab === "ledger" && (
        <div className="panel">
          <h2>Balanced by design</h2>
          <p className="muted">
            Integer cents in USD. Corrections append new journal groups. These
            are simulated accounting entries.
          </p>
          {!s.journals.length ? (
            <Empty icon={BookOpen} title="Your demo ledger is empty">
              Complete a demo checkout to see charge, delivery, and tip entries.
            </Empty>
          ) : (
            s.journals.map((j) => (
              <div className="journal" key={j.id}>
                <div className="journal-head">
                  <strong>{human(j.event.split(":")[0])}</strong>
                  <span className="status success">Balanced</span>
                  <small>{date(j.createdAt)}</small>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Debit</th>
                        <th>Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {j.lines.map((l, i) => (
                        <tr key={i}>
                          <td>{human(l.account)}</td>
                          <td>{l.debit ? money(l.debit) : "—"}</td>
                          <td>{l.credit ? money(l.credit) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>
      )}
      {tab === "applications" && (
        <div className="panel">
          <h2>Host applications</h2>
          {!s.applications.length ? (
            <Empty icon={Users} title="No applications yet">
              Try submitting an application from Host studio.
            </Empty>
          ) : (
            s.applications.map((a) => (
              <div className="case-card" key={a.id}>
                <span className="status">{human(a.status)}</span>
                <h3>{a.name}</h3>
                <p>{a.bio}</p>
                <p className="muted">
                  Approval requires identity checks, training, and payout
                  readiness. This demo never grants live hosting access.
                </p>
                {a.status === "PENDING_REVIEW" && (
                  <div className="button-row">
                    {[
                      ["TRAINING_REQUIRED", "Send to training"],
                      ["DECLINED", "Decline"],
                    ].map(([status, label]) => (
                      <button
                        className="secondary"
                        key={status}
                        onClick={() =>
                          setModal({
                            type: "reason",
                            title: label,
                            label: "Review reason",
                            submit: (reason) =>
                              act(
                                "application-decision",
                                { applicationId: a.id, status, reason },
                                "Application reviewed.",
                              ),
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
      <p className="audit-foot">
        <ShieldCheck size={14} />
        {s.audit.length} recorded demo actions · All role previews operate
        within your own workspace.
      </p>
    </>
  );
}
