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
- Chat and webcams
- Cinema mode
- Optional room password, one broadcaster at a time, host can free the stage
- Viewers can play/pause/seek a local-file broadcast
- Automatic reconnection

## Quick start

Requires Node.js 20+.

```bash
git clone https://github.com/YOUR_USER/loge.git
cd loge
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

## Notes

- Loge shares what your browser shows. It does not bypass DRM, and some
  streaming services render protected video outside the capture pipeline.
  Behavior depends on your browser and each service's terms, so please
  respect them.
- Local file mode does not transmit subtitles; burn them in with ffmpeg if needed.

## License

MIT
