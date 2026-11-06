"use client";
import React from "react";
import { Clock, ArrowRight, Receipt } from "lucide-react";
import { hosts, money } from "../../lib/catalog.mjs";
import { isTerminal } from "../../lib/demo-policy.mjs";
import { hostPhoto } from "../../lib/presentation.mjs";
import { receiptFor } from "../../lib/receipts.mjs";
import { PageHeading, Empty, expName, date, human } from "./shared";
export default function SessionHistory({ s, onStart, openFlow, setModal }) {
  return (
    <>
      <PageHeading
        eyebrow="YOUR MOMENTS"
        title="Every conversation has a place."
      >
        Demo history, receipts, feedback and another hello, all together.
      </PageHeading>
      {!s?.bookings.length ? (
        <Empty
          icon={Clock}
          title="Your first hello is still ahead"
          action={
            <button className="primary" onClick={onStart}>
              Find My Moment <ArrowRight size={17} />
            </button>
          }
        >
          Choose an experience to try the complete demo journey.
        </Empty>
      ) : (
        <div className="session-list">
          {s.bookings.map((b) => {
            const h = hosts.find((h) => h.id === b.hostId);
            return (
              <article className="session-row" key={b.id}>
                <img src={hostPhoto(h.id)} alt="" />
                <div className="session-row-main">
                  <h2>
                    {expName(b.experience)} with {h.name}
                  </h2>
                  <p>
                    {date(b.createdAt)} · {b.duration} min · {human(b.format)} ·{" "}
                    {money(receiptFor(b).net)} demo net
                  </p>
                  <span
                    className={`status ${b.status === "COMPLETED" ? "success" : ""}`}
                  >
                    {human(b.status)}
                  </span>
                  {b.customerMessage && <p>{b.customerMessage}</p>}
                </div>
                <div className="session-row-actions">
                  {!isTerminal(b.status) ? (
                    <button className="primary" onClick={() => openFlow(b)}>
                      Continue <ArrowRight size={17} />
                    </button>
                  ) : (
                    <>
                      <button
                        className="secondary"
                        onClick={() =>
                          setModal({ type: "receipt", booking: b })
                        }
                      >
                        <Receipt size={17} />
                        Receipt
                      </button>
                      <button className="secondary" onClick={() => openFlow(b)}>
                        {b.status === "COMPLETED"
                          ? "Review & tip"
                          : "Service feedback"}
                      </button>
                      <button
                        className="text-btn"
                        onClick={() =>
                          setModal({ type: "profile", host: h, preferences: b })
                        }
                      >
                        Rebook {h.name}
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
