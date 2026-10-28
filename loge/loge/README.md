# Loge

> Seu camarote particular. (Your private box seat.)

Loge is a tiny, self-hosted watch-party room. Share your screen or a local
video file with friends over WebRTC, with chat and webcams. No accounts, no
build step, a handful of files.

## Features

- Rooms by link, no sign-up
- Screen/tab sharing with audio (echo cancellation off, so movie sound stays clean)
- Local video file mode
- Adjustable resolution, fps, bitrate and codec (H.264, VP9, AV1, VP8)
- Live stats (resolution, fps, Mbps, encoder)
- Chat
- Cinema mode
- Optional room password, one broadcaster at a time, host can free the stage
- Viewers can play/pause/seek a local-file broadcast
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
| `TURN_URL`    | --      | Comma-separated TURN URLs     |
| `TURN_SECRET` | --      | coturn `static-auth-secret`   |

Set them in the shell, or copy `.env.example` to `.env` and run
`node --env-file=.env server.js` (Node 20.6+).

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
