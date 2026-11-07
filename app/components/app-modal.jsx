"use client";
import React, { useState } from "react";
import {
  ShieldCheck,
  AlertCircle,
  Check,
  Bell,
  CheckCircle2,
  LogOut,
  PhoneOff,
} from "lucide-react";
import { hosts } from "../../lib/catalog.mjs";
import { browserDemo } from "../../lib/presentation.mjs";
import { Modal, Empty, SignIn, human } from "./shared";
import ProfileDialog from "./profile-dialog";
import ReceiptPanel from "./receipt-panel";
export default function AppModal({
  modal,
  setModal,
  s,
  busy,
  act,
  onFavorite,
  isAvailable,
  openFlow,
  navigate,
}) {
  const close = () => setModal(null);
  const h = modal.host,
    b =
      s?.bookings.find((item) => item.id === modal.booking?.id) ||
      modal.booking;
  const [adult, setAdult] = useState(false),
    [text, setText] = useState(""),
    [name, setName] = useState(""),
    [urgent, setUrgent] = useState(false);
  const title = {
    profile: `Meet ${h?.name}`,
    help: "A space that feels safe",
    terms: "A little more about this demo",
    account: "Your space",
    notifications: "Your updates",
    signin: "Welcome to your space",
    receipt: "Your session details",
    report: "Report a demo concern",
    apply: "Good listeners welcome",
    reason: modal.title,
  }[modal.type];
  return (
    <Modal title={title} close={close} wide={modal.type === "profile"}>
      {modal.type === "profile" && (
        <ProfileDialog
          host={h}
          preferences={modal.preferences}
          s={s}
          busy={busy}
          act={act}
          onFavorite={onFavorite}
          isAvailable={isAvailable}
          setModal={setModal}
          openFlow={openFlow}
          close={close}
        />
      )}
      {modal.type === "signin" && (
        <div className="modal-content">
          <p>
            {browserDemo
              ? "No account is needed for the public preview."
              : "Sign in to keep your saved hosts, session history, and demo activity together."}
          </p>
          <SignIn />
        </div>
      )}
      {modal.type === "help" && (
        <div className="modal-content">
          <div className="safety-lead">
            <ShieldCheck size={31} />
            <p>
              Your comfort comes first. You can end any conversation
              immediately.
            </p>
          </div>
          <h3>Conversations, with clear boundaries</h3>
          <p>
            The proposed service is platonic, for adults 18+ in the U.S. Hosts
            are friendly company, not therapists or crisis professionals.
          </p>
          <h3>You stay in control</h3>
          <p>
            Leave from the call controls at any moment. Report a host from their
            profile or the room, and block them to remove them from your
            discovery.
          </p>
          <h3>
            {browserDemo
              ? "This is a browser-only demo"
              : "This is a private demo"}
          </h3>
          <p>
            Reports are stored in your demo workspace for testing. They are not
            sent to a real safety team. Live staffed hours have not been set;
            paid service is closed.
          </p>
          <div className="notice">
            <AlertCircle size={18} />
            This demo cannot provide emergency assistance. If you are in
            immediate danger, contact local emergency services.
          </div>
          <button className="primary full" onClick={close}>
            Got it
          </button>
        </div>
      )}
      {modal.type === "terms" && (
        <div className="modal-content">
          <p>
            Human Connection V1.3 is an interactive prototype of a human
            conversation marketplace.
          </p>
          <div className="info-item">
            <Check size={18} />
            <span>
              Browse five fictional hosts across Make Me Laugh, Hear Me Out, and
              Distract Me.
            </span>
          </div>
          <div className="info-item">
            <Check size={18} />
            <span>
              Try 15- or 30-minute audio/video flows, simulated checkout,
              reviews, and optional tips.
            </span>
          </div>
          <div className="info-item">
            <Check size={18} />
            <span>
              {browserDemo
                ? "Your activity stays in this browser tab. No login or shared account is used."
                : "Your activity is saved in a private workspace tied to your sign-in."}
            </span>
          </div>
          <h3>Demo policy · version 1.3</h3>
          <p>
            Cancel before joining for a full simulated refund. After checkout,
            enter within three minutes or the reservation expires with a full
            automatic demo reversal. Early exits and failed service create a
            refund review. Tips are optional after completed sessions, within 24
            hours, with a $1–$50 range. No real funds move.
          </p>
          <p>
            AI-generated scenes illustrate the experience choices. Stock photos
            illustrate fictional host profiles. Live payments, real host
            verification, live video, and staffed safety response require
            production integrations and approvals. No service hours are
            advertised until then.
          </p>
        </div>
      )}
      {modal.type === "notifications" && (
        <div className="modal-content">
          {!s ? (
            <SignIn />
          ) : !s.audit.length ? (
            <Empty icon={Bell} title="A quiet moment">
              Your recent demo activity will appear here.
            </Empty>
          ) : (
            s.audit.slice(0, 10).map((a) => (
              <div className="notification-row" key={a.id}>
                <CheckCircle2 size={17} />
                <span>
                  {human(a.action.replaceAll("-", " "))}
                  <small>{new Date(a.createdAt).toLocaleString()}</small>
                </span>
              </div>
            ))
          )}
        </div>
      )}
      {modal.type === "account" && (
        <div className="modal-content">
          {!s ? (
            <SignIn />
          ) : (
            <>
              <div className="account-card">
                <span className="avatar">
                  {s.viewer?.name?.slice(0, 1)?.toUpperCase()}
                </span>
                <div>
                  <strong>{s.viewer?.name}</strong>
                  <small>
                    {browserDemo
                      ? "Local browser demo"
                      : "Private demo workspace"}
                  </small>
                </div>
              </div>
              <h3>Blocked hosts</h3>
              {!s.blocks.length ? (
                <p className="muted">No blocked hosts.</p>
              ) : (
                s.blocks.map((id) => (
                  <div className="setting-row" key={id}>
                    <span>{hosts.find((h) => h.id === id)?.name}</span>
                    <button
                      className="secondary"
                      onClick={() =>
                        act("unblock", { hostId: id }, "Host unblocked.")
                      }
                    >
                      Unblock
                    </button>
                  </div>
                ))
              )}
              <h3>Account & data</h3>
              <p>
                {browserDemo
                  ? "Your demo activity is stored in this tab only."
                  : "Your prototype activity is saved on the server."}{" "}
                Closing your account removes profile content and prevents new
                sessions; demo financial records are retained until you reset.
              </p>
              <button
                className="secondary full"
                onClick={() =>
                  setModal({
                    type: "reason",
                    title: "Close demo account",
                    label: "Type CLOSE to confirm",
                    submit: async (reason) => {
                      if (reason !== "CLOSE") return null;
                      return act("close-account", {}, "Demo account closed.");
                    },
                  })
                }
              >
                Close demo account
              </button>
              <button
                className="text-btn roomy"
                onClick={() =>
                  setModal({
                    type: "reason",
                    title: "Reset your demo workspace",
                    label: "Type RESET to delete all demo activity",
                    submit: async (reason) => {
                      if (reason !== "RESET") return null;
                      const d = await act("reset", {}, "Demo workspace reset.");
                      if (d) navigate("discover");
                      return d;
                    },
                  })
                }
              >
                Reset all demo data
              </button>
              <span>
                {!browserDemo && (
                  <a
                    className="text-btn"
                    href="/signout-with-chatgpt?return_to=/"
                    target="_top"
                  >
                    <LogOut size={16} />
                    Sign out
                  </a>
                )}
              </span>
            </>
          )}
        </div>
      )}
      {modal.type === "receipt" && (
        <ReceiptPanel b={b} s={s} setModal={setModal} act={act} />
      )}
      {modal.type === "report" && (
        <form
          className="modal-content"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!s) {
              setModal({ type: "signin" });
              return;
            }
            const d = await act(
              "report",
              { hostId: h.id, bookingId: b?.id, reason: text, urgent },
              "Demo report saved. No real operator has been notified.",
            );
            if (d) close();
          }}
        >
          <p>
            Tell us about your concern with {h.name}. Reports in this demo
            appear in Operations, within your private workspace.
          </p>
          <label className="field-label">
            What happened?
            <textarea
              required
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Share the details you’re comfortable sharing."
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={urgent}
              onChange={(e) => setUrgent(e.target.checked)}
            />
            Mark urgent{b && " and end this session immediately"}
          </label>
          <div className="notice">
            <AlertCircle size={17} />
            Demo reports do not reach a live safety operator.
          </div>
          <button className="primary full" disabled={busy || !text.trim()}>
            Save demo report
          </button>
          {b && ["LIVE", "RECONNECTING"].includes(b.status) && (
            <button
              type="button"
              className="secondary full"
              onClick={async () => {
                await act("leave", { bookingId: b.id });
                close();
              }}
            >
              <PhoneOff size={17} />
              Leave now
            </button>
          )}
        </form>
      )}
      {modal.type === "apply" && (
        <form
          className="modal-content"
          onSubmit={async (e) => {
            e.preventDefault();
            const d = await act(
              "apply",
              { name, bio: text, adult },
              "Demo application submitted.",
            );
            if (d) close();
          }}
        >
          <p>
            Introduce yourself. A real host would also complete identity
            verification, a mock conversation, training, and payout onboarding
            before going online.
          </p>
          {s?.applications.length ? (
            <div className="notice">
              Application status: {human(s.applications[0].status)}
            </div>
          ) : (
            <>
              <label className="field-label">
                Your name
                <input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="field-label">
                What makes you good company?
                <textarea
                  required
                  maxLength={1000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  required
                  checked={adult}
                  onChange={(e) => setAdult(e.target.checked)}
                />
                I am 18 or older.
              </label>
              <button className="primary full" disabled={busy}>
                Submit demo application
              </button>
            </>
          )}
        </form>
      )}
      {modal.type === "reason" && (
        <form
          className="modal-content"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await modal.submit(text);
            if (result) close();
            else if (text !== "" && modal.label.startsWith("Type")) setText("");
          }}
        >
          <label className="field-label">
            {modal.label}
            <textarea
              required
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
          </label>
          <button className="primary full" disabled={busy || !text.trim()}>
            Confirm
          </button>
        </form>
      )}
    </Modal>
  );
}
