# Loge

> Seu camarote particular. (Your private box seat.)

Loge is a tiny, self-hosted watch-party room. Share your screen or a local
video file with friends over WebRTC, with chat and webcams. No accounts, no
build step, a handful of files.

## Features

- Rooms by link, no sign-up
- Profiles (name + photo, no password) and permanent rooms with their own link
- Screen/tab sharing with audio (echo cancellation off, so movie sound stays clean)
- Local video file mode
- Adjustable resolution, fps, bitrate and codec (H.264, VP9, AV1, VP8)
- Live stats (resolution, fps, Mbps, encoder)
- Chat and voice chat (mic button, mute/unmute, M key)
- GIF search and sharing in chat, powered by GIPHY
- Cinema mode
- Optional room password, one broadcaster at a time, host can free the stage
- Nobody can pause the video, and the sound is always on (viewers can still seek a local-file broadcast)
- Automatic reconnection

## Quick start

Requires Node.js 20+.

```bash
git clone https://github.com/iegomonteiro/lodge.git
cd lodge/loge/loge
npm install
npm start
```

Open http://localhost:3000, create a room and share the link.

## Friends outside your network

1. Expose the server over HTTPS, e.g.
   `cloudflared tunnel --url http://localhost:3000`
2. Create the room from the public URL.
3. If some friends cannot connect, run a TURN server (coturn) and set
   `TURN_URL` and `TURN_SECRET` (see `.env.example`).

> **HTTPS is required for screen sharing.** Browsers only allow screen capture
> on secure origins: `https://` or `http://localhost`. Opening the server by
> its LAN address (e.g. `http://192.168.0.10:3000`) lets people join and chat,
> but "Compartilhar tela" will not work there. Use a tunnel or a reverse proxy
> with HTTPS.

Media goes peer to peer; the server only handles signaling and chat.
Each viewer gets a separate stream, so your upload bandwidth is
bitrate × number of viewers.

## Configuration

| Variable      | Default | Description                   |
|---------------|---------|-------------------------------|
| `PORT`        | 3000    | HTTP/WebSocket port           |
| `MAX_PEERS`   | 8       | Maximum people per room       |
| `GIPHY_API_KEY` | -- | GIPHY API key for GIF search in chat |
| `DATA_DIR`    | `./data`| Where permanent rooms are saved |
| `MAX_FIXED_ROOMS` | 200 | Permanent rooms on the whole server |
| `TURN_URL`    | --      | Comma-separated TURN URLs     |
| `TURN_SECRET` | --      | coturn `static-auth-secret`   |

Set them in the shell, or copy `.env.example` to `.env` and run
`node --env-file=.env server.js` (Node 20.6+). To enable GIFs, set
`GIPHY_API_KEY` to your key. On a hosting service such as Render, add it as an
environment variable in the service settings; never put the real key in GitHub
or in browser JavaScript.

## Profiles and permanent rooms

On the home page, create a profile: just a name and a photo, no password. It lives
in your browser. Profile holders can create **permanent rooms**: the link never
changes, the room does not disappear when it empties, anyone with the link can
join (with an optional password), and the owner is always the host and enters
without typing the password. Owners can rename a room, change or remove its
password, or delete it from the home page. Anyone without a profile can still
join with just a name, or create a quick (temporary) room.

- Permanent rooms are saved to `DATA_DIR/salas.json` (back it up; it is git-ignored).
- The profile's **recovery code** ("Meu código" on the home page) is the proof that
  you own your rooms. Save it somewhere safe: it restores your profile on another
  device or after clearing browser data, and anyone who has it can act as you.
  The server stores only a hash of it. Use HTTPS so it is not sent in clear text.
- Limits: 10 permanent rooms per profile, 200 per server, 30 creations per hour per
  network address.

## No pause, sound always on

There is no pause or "enable audio" button. Viewers hear the sound from the moment
they enter (the Enter tap unlocks audio, which is what makes this work on iPhone),
and the video keeps playing; if something pauses it (for example the iPhone native
player), it resumes by itself. In file mode the broadcaster has no controls either.

## Voice chat

Press the microphone button in the top bar to join the voice chat; press it again
to mute or unmute (on a computer you can also press `M`). Everyone sees who is in
the voice chat, who is muted and who is speaking. Voice goes peer to peer like the
broadcast, using the same connections, and needs HTTPS (or `localhost`) just like
screen sharing.

- Use headphones. With the movie on speakers, microphones pick it up and friends
  hear it twice.
- Muting turns the microphone track off but the browser keeps the microphone open
  (like Discord), so unmuting is instant. Close the tab to release it.
- Each voice stream is about 30 kbps per person, so rooms of up to 8 are fine.

## On iPhone

The layout is tuned for the iPhone 13/14 (390 x 844 pt, portrait and landscape).
Safari on iPhone can watch and chat, but it cannot share the screen or a file, so
those buttons are hidden there. The fullscreen button uses the native video player
(the only fullscreen Safari allows on iPhone). For a bar-less view, use
Share > Add to Home Screen and open Loge from the icon.

## Room passwords and limits

- The first person to join a room sets its password (leave it empty for an
  open room). The password is kept in memory only, salted, and survives for
  10 minutes after the room empties, so the link is not reopened by someone
  recreating the room. A server restart clears it.
- After 10 wrong passwords a room refuses joins for one minute.
- Each connection is rate limited (messages overall and chat in particular).

## Notes

- Loge shares what your browser shows. It does not bypass DRM, and some
  streaming services render protected video outside the capture pipeline.
  Behavior depends on your browser and each service's terms, so please
  respect them.
- Local file mode does not transmit subtitles; burn them in with ffmpeg if needed.

## License

MIT
