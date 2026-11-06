"use client";
import React from "react";
import { Receipt, Flag } from "lucide-react";
import { hosts, money } from "../../lib/catalog.mjs";
import { receiptFor } from "../../lib/receipts.mjs";
import { isTerminal } from "../../lib/demo-policy.mjs";
import { Mark, expName, human, date } from "./shared";
export default function ReceiptPanel({ b, s, setModal, act }) {
  const r = receiptFor(b);
  return (
    <div className="modal-content">
      <div className="receipt-brand">
        <Mark />
        <strong>human connection.</strong>
        <span>DEMO RECEIPT</span>
      </div>
      <h3>
        {expName(b.experience)} with{" "}
        {hosts.find((h) => h.id === b.hostId)?.name}
      </h3>
      <p>
        {date(b.createdAt)} · {b.duration} minutes · {human(b.format)}
      </p>
      <dl className="receipt-details">
        {[
          ["Session status", human(r.sessionStatus)],
          ["Payment status", human(r.paymentStatus)],
          ["Original base charge", money(r.baseCharge)],
          ["Base refund", r.baseRefund ? `−${money(r.baseRefund)}` : "$0"],
          ["Original tip", money(r.tipCharge)],
          ["Tip refund", r.tipRefund ? `−${money(r.tipRefund)}` : "$0"],
          ["Final demo net", money(r.net)],
          ["Real money charged", "$0"],
          ["Policy", b.policyVersion],
        ].map(([label, value]) => (
          <div
            key={label}
            className={label === "Final demo net" ? "total" : ""}
          >
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {b.customerMessage && <p className="notice">{b.customerMessage}</p>}
      <p className="microcopy">Reference: {b.id}</p>
      {isTerminal(b.status) &&
        b.payment === "SIMULATED_SUCCEEDED" &&
        !s.refunds.some((r) => r.bookingId === b.id) && (
          <button
            className="secondary full"
            onClick={() =>
              setModal({
                type: "reason",
                title: "Request a refund review",
                label: "Tell us what happened (fictional details only)",
                submit: (reason) =>
                  act(
                    "refund-request",
                    { bookingId: b.id, reason },
                    "Your demo refund request is saved.",
                  ),
              })
            }
          >
            Request refund review
          </button>
        )}
      {s.refunds
        .filter((r) => r.bookingId === b.id)
        .map((r) => (
          <div className="notice" key={r.id}>
            <Receipt size={18} />
            Demo refund review: {human(r.status)}
          </div>
        ))}
      {b.payment === "SIMULATED_REFUNDED" && (
        <>
          <button
            className="secondary full"
            onClick={() =>
              setModal({
                type: "reason",
                title: "Feedback on the demo refund",
                label: "Refund feedback (separate from host ratings)",
                submit: (text) =>
                  act(
                    "refund-feedback",
                    { bookingId: b.id, text },
                    "Refund feedback saved separately.",
                  ),
              })
            }
          >
            Share refund feedback
          </button>
          {b.refundFeedback && (
            <p>Saved refund feedback: {b.refundFeedback.text}</p>
          )}
        </>
      )}
      <button
        className="text-btn roomy"
        onClick={() =>
          setModal({
            type: "report",
            host: hosts.find((h) => h.id === b.hostId),
            booking: b,
          })
        }
      >
        Report a demo concern <Flag size={15} />
      </button>
    </div>
  );
}
