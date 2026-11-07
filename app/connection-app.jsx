"use client";
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Heart,
  Clock,
  Menu,
  Settings,
  Bell,
  X,
  Radio,
  AlertCircle,
  CheckCircle2,
  Lock,
} from "lucide-react";
import { hosts } from "../lib/catalog.mjs";
import { browserDemo } from "../lib/presentation.mjs";
import { isTerminal } from "../lib/demo-policy.mjs";
import { hostAvailable, rankMatches } from "../lib/matching.mjs";
import {
  Mark,
  Modal,
  Empty,
  PageHeading,
  SignIn,
  human,
} from "./components/shared";
import Landing from "./components/landing";
import MomentFinder from "./components/moment-finder";
import HostBrowser from "./components/host-browser";
import SessionHistory from "./components/session-history";
import SessionFlow from "./components/session-flow";
import HostStudio from "./components/host-studio";
import Operations from "./components/operations";
import AppModal from "./components/app-modal";
import { EligibilityDialog } from "./components/booking-options";

const defaultFilters = {
  experience: "all",
  format: "any",
  language: "any",
  query: "",
};
export default function ConnectionApp({ request = fetch } = {}) {
  const [s, setS] = useState(null),
    [auth, setAuth] = useState(false),
    [loadError, setLoadError] = useState("");
  const [view, setView] = useState("discover"),
    [modal, setModal] = useState(null),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState(""),
    [now, setNow] = useState(0);
  const [activeId, setActiveId] = useState(null),
    [opsTab, setOpsTab] = useState("overview"),
    [step, setStep] = useState(0),
    [matchError, setMatchError] = useState("");
  const [preferences, setPreferences] = useState({
      experience: "hear",
      style: null,
      duration: 15,
      format: "audio",
      language: "English",
    }),
    [filters, setFilters] = useState(defaultFilters);
  const lock = useRef(false),
    offset = useRef(0),
    requestVersion = useRef(0),
    main = useRef(null);
  const adopt = useCallback((data) => {
    setS(data);
    offset.current = data.serverNow - Date.now();
    setNow(data.serverNow);
  }, []);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const r = await request("/api/state");
      const data = await r.json();
      if (version !== requestVersion.current) return;
      if (r.status === 401) {
        setAuth(true);
        return;
      }
      if (!r.ok) throw Error(data.error?.message || "Unable to open the demo.");
      adopt(data);
      setAuth(false);
      setLoadError("");
    } catch (error) {
      if (version === requestVersion.current)
        setLoadError(error.message || "Unable to open your workspace.");
    }
  }, [adopt, request]);
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) void refresh();
    });
    const tick = setInterval(() => setNow(Date.now() + offset.current), 1000);
    const poll = setInterval(() => {
      if (!lock.current) void refresh();
    }, 5000);
    return () => {
      mounted = false;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    main.current?.focus();
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view]);
  async function act(action, payload = {}, message) {
    if (lock.current) return null;
    lock.current = true;
    setBusy(true);
    requestVersion.current++;
    try {
      const r = await request("/api/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ action, payload }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (r.status === 401) setAuth(true);
        throw Error(data.error?.message || "Unable to save this demo action.");
      }
      adopt(data.state);
      if (message) setToast(message);
      return data;
    } catch (error) {
      setToast(error.message);
      await refresh();
      return null;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const inProgress = s?.bookings.find((b) => !isTerminal(b.status));
  const active = s?.bookings.find((b) => b.id === activeId) || inProgress;
  const navigate = (next) => {
    setView(next);
    setModal(null);
  };
  const openFlow = (booking) => {
    setActiveId(booking.id);
    navigate("session");
  };
  const onFavorite = (host) => {
    if (!s) {
      setModal({ type: "signin" });
      return;
    }
    act("favorite", { hostId: host.id });
  };
  const onOpen = (host) => setModal({ type: "profile", host, preferences });
  const onStart = () => {
    setStep(0);
    setMatchError("");
    navigate("moment");
  };
  const chooseExperience = (experience, style = null) => {
    setPreferences({ ...preferences, experience, style });
    setStep(style ? 2 : 1);
    setMatchError("");
    navigate("moment");
  };
  const browse = (withPreferences = false) => {
    setFilters(
      withPreferences
        ? {
            experience: preferences.experience,
            format: preferences.format,
            language: preferences.language,
            query: "",
          }
        : defaultFilters,
    );
    navigate("browse");
  };
  async function match(consent) {
    if (!s) {
      setModal({ type: "signin" });
      return;
    }
    const ranked = rankMatches(s, preferences);
    if (!ranked.matches.length) {
      setMatchError(ranked.reason);
      return;
    }
    if (!s.eligible) {
      if (!consent) {
        setModal({ type: "eligibility" });
        return;
      }
      if (!(await act("eligibility", consent))) return;
    }
    const response = await act("match", preferences);
    if (response) {
      setMatchError("");
      openFlow(
        response.state.bookings.find((b) => b.id === response.result.bookingId),
      );
    } else {
      setModal(null);
      setMatchError(
        "That match could not be reserved. Your choices are saved. Check availability and try again.",
      );
    }
  }
  const isAvailable = (host) => hostAvailable(s, host);
  return (
    <div className="app-shell">
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header className="site-header">
        <button
          className="brand"
          onClick={() => navigate("discover")}
          aria-label="Human Connection home"
        >
          <span className="brand-mark">
            <Mark />
          </span>
          <span>
            human
            <br />
            connection<span className="brand-dot">.</span>
          </span>
        </button>
        <nav className="desktop-nav" aria-label="Main navigation">
          <button
            className={
              ["discover", "moment", "browse"].includes(view) ? "active" : ""
            }
            onClick={onStart}
          >
            Find a moment
          </button>
          <button
            className={view === "saved" ? "active" : ""}
            onClick={() => {
              setFilters(defaultFilters);
              navigate("saved");
            }}
          >
            <Heart size={16} />
            Saved hosts
          </button>
          <button
            className={view === "history" ? "active" : ""}
            onClick={() => navigate("history")}
          >
            <Clock size={16} />
            My sessions
          </button>
        </nav>
        <div className="header-actions">
          <button
            className="tools-link"
            onClick={() => setModal({ type: "tools" })}
          >
            Demo tools
          </button>
          <button
            className="icon-btn"
            aria-label="Notifications"
            onClick={() => setModal({ type: "notifications" })}
          >
            <Bell size={19} />
          </button>
          <button
            className="icon-btn account-icon"
            aria-label="Your demo account"
            onClick={() => setModal({ type: "account" })}
          >
            <Settings size={19} />
          </button>
          <button
            className="icon-btn mobile-menu"
            aria-label="Open menu"
            onClick={() => setModal({ type: "menu" })}
          >
            <Menu size={22} />
          </button>
        </div>
      </header>
      <div className="public-preview-note">
        <span className="demo-chip">
          <i />
          {browserDemo ? "PUBLIC DEMO" : "PRIVATE DEMO"}
        </span>
        <span>
          Fictional hosts. No real calls or charges.{" "}
          {browserDemo
            ? "Activity stays in this tab."
            : "Activity stays in your signed-in workspace."}
        </span>
        <button onClick={() => setModal({ type: "terms" })}>
          How it works
        </button>
      </div>
      <main id="main" ref={main} tabIndex={-1}>
        {loadError && (
          <div className="notice error" role="alert">
            <AlertCircle size={18} />
            {loadError}
            <button onClick={refresh}>Retry</button>
          </div>
        )}
        {auth && <SignIn />}
        {s?.closed ? (
          <Empty
            icon={Lock}
            title="Your demo account is closed"
            action={
              <button
                className="primary"
                onClick={() =>
                  act("reset", {}, "A fresh demo workspace is ready.")
                }
              >
                Start a fresh demo
              </button>
            }
          >
            Profile content has been removed. Demo financial records remain
            until you reset this workspace.
          </Empty>
        ) : (
          <>
            {view !== "session" && inProgress && (
              <button
                className="resume-banner"
                onClick={() => openFlow(inProgress)}
              >
                <Radio size={18} />
                <span>
                  Your moment with{" "}
                  {hosts.find((h) => h.id === inProgress.hostId)?.name} ·{" "}
                  {human(inProgress.status)}
                </span>
                <strong>
                  Continue <ArrowRight size={16} />
                </strong>
              </button>
            )}
            {view === "discover" && (
              <Landing
                onStart={onStart}
                onChoose={chooseExperience}
                onBrowse={() => browse()}
                onHelp={() => setModal({ type: "help" })}
              />
            )}
            {view === "moment" && (
              <MomentFinder
                preferences={preferences}
                onChange={(value) => {
                  setPreferences(value);
                  setMatchError("");
                }}
                step={step}
                setStep={setStep}
                onHome={() => navigate("discover")}
                onBrowse={() => browse(true)}
                onMatch={() => match()}
                busy={busy}
                error={matchError}
              />
            )}
            {(view === "browse" || view === "saved") && (
              <HostBrowser
                s={s}
                saved={view === "saved"}
                filters={filters}
                setFilters={setFilters}
                onOpen={onOpen}
                onFavorite={onFavorite}
                onBack={() => navigate("moment")}
                onClear={() => browse()}
              />
            )}
            {view === "history" && (
              <SessionHistory
                s={s}
                onStart={onStart}
                openFlow={openFlow}
                setModal={setModal}
              />
            )}
            {view === "session" &&
              (active ? (
                <SessionFlow
                  key={active.id}
                  b={active}
                  s={s}
                  now={now}
                  busy={busy}
                  act={act}
                  setModal={setModal}
                  navigate={navigate}
                />
              ) : (
                <Empty
                  title="A little connection starts here"
                  action={
                    <button className="primary" onClick={onStart}>
                      Find My Moment
                    </button>
                  }
                >
                  Choose an experience to start the demo.
                </Empty>
              ))}
            {view === "host" && (
              <HostStudio
                s={s}
                now={now}
                act={act}
                busy={busy}
                setModal={setModal}
              />
            )}
            {view === "ops" && (
              <>
                <PageHeading
                  eyebrow="OPERATIONS · FICTIONAL ROLE PREVIEW"
                  title="Care behind every conversation."
                >
                  Try safety, refund and finance controls within your own
                  workspace. These are not production permissions or staffed
                  services.
                </PageHeading>
                <div
                  className="ops-tabs"
                  role="group"
                  aria-label="Operations sections"
                >
                  {[
                    "overview",
                    "safety",
                    "refunds",
                    "ledger",
                    "applications",
                  ].map((tab) => (
                    <button
                      key={tab}
                      className={opsTab === tab ? "active" : ""}
                      aria-pressed={opsTab === tab}
                      onClick={() => setOpsTab(tab)}
                    >
                      {human(tab)}
                    </button>
                  ))}
                </div>
                {s ? (
                  <Operations
                    s={s}
                    tab={opsTab}
                    act={act}
                    busy={busy}
                    setModal={setModal}
                  />
                ) : (
                  <SignIn />
                )}
              </>
            )}
          </>
        )}
        <footer className="page-footer">
          <span>Human connection, on your terms.</span>
          <span>
            Adults 18+ · Platonic entertainment · No routine recording
          </span>
          <button onClick={() => setModal({ type: "help" })}>
            Help & safety <ArrowUpRight size={15} />
          </button>
        </footer>
      </main>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {["tools", "menu"].includes(modal?.type) ? (
        <Modal
          title={
            modal.type === "menu" ? "Your little space" : "Explore the demo"
          }
          close={() => setModal(null)}
        >
          <nav className="menu-links" aria-label="Demo navigation">
            {modal.type === "menu" && (
              <>
                <button onClick={onStart}>
                  Find My Moment <ArrowRight size={17} />
                </button>
                <button onClick={() => browse()}>Explore hosts</button>
                <button
                  onClick={() => {
                    setFilters(defaultFilters);
                    navigate("saved");
                  }}
                >
                  Saved hosts
                </button>
                <button onClick={() => navigate("history")}>My sessions</button>
                <button onClick={() => setModal({ type: "account" })}>
                  Your demo account
                </button>
              </>
            )}
            <button onClick={() => navigate("host")}>
              Host studio preview <ArrowUpRight size={17} />
            </button>
            <button onClick={() => navigate("ops")}>
              Operations preview <ArrowUpRight size={17} />
            </button>
            <button onClick={() => setModal({ type: "help" })}>
              Help & safety
            </button>
            <p className="demo-caption">
              One fictional workspace, with all role previews. Real customer,
              host and administrator access would be separate.
            </p>
          </nav>
        </Modal>
      ) : modal?.type === "eligibility" ? (
        <EligibilityDialog
          close={() => setModal(null)}
          busy={busy}
          onReady={match}
        />
      ) : (
        modal && (
          <AppModal
            key={`${modal.type}-${modal.host?.id || modal.title || modal.booking?.id || ""}`}
            modal={modal}
            setModal={setModal}
            s={s}
            busy={busy}
            act={act}
            onFavorite={onFavorite}
            isAvailable={isAvailable}
            openFlow={openFlow}
            navigate={navigate}
          />
        )
      )}
    </div>
  );
}
