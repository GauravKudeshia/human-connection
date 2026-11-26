"use client";

import React, { useRef, useState } from "react";
import { languageName } from "../../lib/conversation-languages.mjs";

export default function HostIntroduction({ intro, review = false }) {
  const [mediaError, setMediaError] = useState("");
  const player = useRef(null);
  const disclosure = useRef(null);
  if (!intro) return null;

  const video = intro.content_type.startsWith("video/");
  const captionLanguage = intro.caption_language;
  const id = encodeURIComponent(intro.id);
  const src = "/api/marketplace/media?id=" + id;
  function failMedia(message) {
    if (document.activeElement === player.current) disclosure.current?.focus();
    setMediaError(message);
  }
  const play = (
    video ? (
      <video
        className="beta-intro-player"
        ref={player}
        controls
        preload="none"
        src={src}
        aria-label="Host introduction video"
        onError={() => failMedia("Video is unavailable. The introduction is available in text.")}
      >
        {captionLanguage && (
          <track
            kind="captions"
            src={"/api/marketplace/media?kind=captions&id=" + id}
            srcLang={captionLanguage}
            label={`${languageName(captionLanguage)} captions`}
            default
            onError={() => failMedia("Captions are unavailable. The introduction is available in text.")}
          />
        )}
      </video>
    ) : (
      <audio
        className="beta-intro-player"
        ref={player}
        controls
        preload="none"
        src={src}
        aria-label="Host introduction audio"
        onError={() => failMedia("Audio is unavailable. The introduction is available in text.")}
      />
    )
  );
  const playback = mediaError ? <p className="beta-small" role="status">{mediaError}</p> : play;
  return (
    <section className="beta-introduction" aria-label={review ? "Introduction awaiting review" : "Host introduction"}>
      <h3>Introduction</h3>
      <p className="beta-wrap">{intro.transcript}</p>
      {review ? (
        playback
      ) : (!video || captionLanguage) && (
        <details>
          <summary ref={disclosure}>{video ? "Watch with captions" : "Listen to the introduction"}</summary>
          {playback}
        </details>
      )}
    </section>
  );
}
