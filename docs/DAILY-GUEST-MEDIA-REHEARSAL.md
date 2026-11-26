# Three-person Daily rehearsal

Guest invitations exercise host approval, the guest’s terms and the paying customer’s admission decision in the local preview. The current media adapter provisions a private room for the paying customer and host. It requires Daily’s room response to confirm the two-person limit, unique user IDs and the original room expiry. The app checks paid attendance against those two members. [Adapter](../lib/marketplace/providers.mjs) · [Attendance](../lib/marketplace/sessions.mjs)

The executable local rehearsal checks room creation and collision recovery with fixture responses. It also tests genuine application approval state and signed fixture events. An approved preview guest receives no third media grant and cannot alter attendance, the clock or billing. Run it with `node --test tests/marketplace-daily-guest-rehearsal.test.mjs`. [Fixture tests](../tests/marketplace-daily-guest-rehearsal.test.mjs)

## Provider boundary

Daily supports a private room limit, unique user IDs and room expiry. A meeting token can carry the intended room, expiry, user ID and send permissions. Daily documents that an unexpired token can be reused to rejoin a private room. [Room API](https://docs.daily.co/reference/rest-api/rooms/create-room) · [Meeting tokens](https://docs.daily.co/reference/rest-api/meeting-tokens) · [Create a token](https://docs.daily.co/reference/rest-api/meeting-tokens/create-meeting-token)

Daily’s eject request accepts a room name, participant user IDs and a ban option. Its response lists ejected participant sessions. The public reference does not establish whether a ban persists when the old meeting becomes empty and a new meeting starts in the same room, or whether an empty ejection list confirms a ban on an absent user. This distinction matters because the app reuses the same room for a booking during reconnect. [Eject API](https://docs.daily.co/reference/rest-api/rooms/session/eject)

## Evidence required for three-person media

1. Provision one isolated, authorized test room per booking with capacity for three people. Issue a scoped guest grant only after both application approvals. Confirm that the guest has no admin, recording, transcription or screen-sharing permissions and that an audio-only guest cannot send video.
2. Keep guest presence separate from the customer and host’s signed delivery evidence. Confirm a guest joining, disconnecting, reconnecting, leaving and being removed does not change the original deadline, price or payout calculation.
3. Verify removal and host withdrawal with a connected guest, an already-disconnected guest, a delayed grant response and duplicate removal requests. Attempt re-entry with the already-issued token before expiry, including after everyone leaves and the same room is reopened. Record what the provider actually confirms when it returns no ejected participant IDs.
4. Verify session end, authorization changes and provider outages. Confirm that app controls report the actual provider outcome and that retries do not restore guest access. If a provider ban cannot survive a reopened room, validate a replacement room or another enforceable provider mechanism before issuing guest tokens.
5. Exercise the controlled audio and video paths across three independent browsers. Preserve a test result for admission, guest-only removal and timeout without recording a conversation.

Real three-person media is disabled. The local fixture describes the boundary that currently ships and has no credentials or network calls.
