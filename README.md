# Together

A Windows desktop app for watching a shared screen with friends while talking on camera and microphone. Includes a browser viewer and a self-hostable signaling server. No screen, camera, or microphone is enabled just by joining.

## Run the Windows app

Keep `release/Together-1.1.2-Windows.exe` on D: and open it. The launcher extracts the app into `Together-data/Runtime` beside the EXE, then reuses that copy on later launches. Profiles, browser caches, logs, and temporary files also stay in `Together-data` beside the EXE. Close the old version first. You can send just this EXE to friends; it creates its own data folder on their chosen drive.

This portable build needs no installer or separate Node installation. The Windows launcher uses .NET Framework 4.x, included with Windows 11; see [Microsoft's included .NET versions](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-10). Windows may identify the unsigned application as unrecognized; a commercial distribution should be code signed.

1. Enter your name and choose **Create a room**.
2. Choose **Copy code** and send the entire code to your friends. It includes the server address and a private room credential. Keep it private.
3. Each friend opens Together, enters their name, pastes that code, and chooses **Join**. Opening an invite link also works in a current browser.
4. The host chooses **Share screen**, then selects a screen or window. **Share computer sound** includes system audio. Camera and microphone have their own on/off buttons for every person in the room.
5. Stop sharing to end only the screen stream. Leaving as host ends the room for everyone and stops every participant's devices.

The source picker opens on **Entire screen · all apps**, which shares a complete monitor, including all browsers and applications on it. **One application window** limits sharing to one window. The fullscreen button and double-clicking the stream enlarge the viewer; **F** toggles fullscreen and **Esc** exits it.

## Open invites in the app

Both the host and friends should use version 1.1.1 or newer. Each person runs the EXE once to register Windows `together-watch://` links to that copy of Together. Use **Copy direct app link** for an app URI, or **Copy invite link** for a web link that attempts to hand off to Together and offers an explicit **Open in Together app** button. Browsers can require an **Open Together** confirmation; a website cannot bypass that safety prompt or run an EXE that has never been opened/registered.

An invitation carries the exact server and room code into the app. It hides **Create a room** and shows **Join this room**, so joining cannot accidentally create a separate room. Enter your name and join. If you're already in another room, leave it before joining the queued invitation. Camera and microphone remain off until you turn them on.

The browser fallback joins that same room, with its supplied server pinned. Legacy `/ROOMCODE` URLs redirect to the browser-safe `/#code=ROOMCODE` form. Prefer the copy buttons rather than manually editing a room address.

After updating the host, create a fresh room and public address and share the new invite. Old room codes stop working when the old host room/server is closed. If you move the EXE, run it again to update Windows' app-link registration.

Microphone and camera controls play distinct local tones and voice prompts such as “Microphone muted” and “Camera activated.” Choose **Voice + tones**, **Tones only**, or **Off** under Device confirmation sounds. Spoken prompts use your installed system voice; tones remain available if no voice is installed.

The included local server works between devices that can reach the host's local network address. Use the desktop app on each device for camera and microphone over a plain HTTP LAN. An HTTP browser viewer can receive streams, but browser camera/microphone access requires HTTPS or localhost. Windows Firewall may need to allow Together on your private network. The app chooses the first active non-loopback IPv4 address; with VPNs or multiple adapters, adjust the address in the copied code to the reachable host address.

A `192.168…` meeting code is local-network access. For friends in another place, use **Start internet room · free**, wait for the public address, and copy the NEW meeting code. See the internet section below.

## High frame rates

Choose **120, 144, 165, or 240 FPS** as the requested screen capture and WebRTC encoder ceiling. The default is **Original/source resolution** at a 120 FPS target with **Automatic · best available** bandwidth. Original mode keeps the source's native aspect ratio and dimensions. Automatic bandwidth removes the app's artificial video-bitrate cap. There are optional resolution, bitrate-limit, and codec controls. Cameras use up to 640 × 360 at 30 FPS to leave more resources for the screen.

Version 1.1.2 explicitly selects the active screen encoder from codecs negotiated by both devices. Automatic mode checks encoding capabilities at the capture dimensions and prefers accelerated H.264 when available, followed by other accelerated negotiated codecs. This fixes a case where choosing H.264 still left the actual stream using software VP8. Older browsers that cannot select an encoding's codec retain their normal negotiated codec and report that fallback. The details panel shows the actual codec and encoder implementation; capability hints alone do not prove hardware is in use.

Screen negotiation also seeds a bounded initial bandwidth estimate instead of starving a large hardware-encoded screen at the small default startup estimate. It does not force a minimum bitrate, disable congestion control, impose a new quality ceiling, or reduce the source resolution. Manual bitrate ceilings still apply.

These are targets, not a guarantee of more than 100 FPS. The source animation, display refresh, capture API, GPU/encoder, codec, network, and viewer decoder all affect delivered frames. A 24 FPS movie remains 24 FPS content. For a 60 FPS video, choose 60 FPS to match its real frame rate. Static screen content can produce low frame counters because there is nothing new to send. Keep Original/source resolution selected while investigating a bottleneck.

The quality panel distinguishes the requested target, actual capture size, and encoded/received size. Changing quality while sharing applies capture constraints and sender limits immediately. A 1920 × 1080 display or a 1920 × 1020 browser window cannot supply true 3840 × 2160 detail: selecting 4K does not invent missing pixels. For true 4K screen capture, choose a source that actually renders at 4K. Fullscreen enlarges the picture without adding source detail.

The live panel measures encoded/decoded screen frames from WebRTC counters. The host sees the lowest measured frame rate across connected viewers and total screen-video bitrate across them; a viewer sees its own received stream. Failed connections and inactive RTP reports are excluded from that counter. A failed media path is shown as unavailable rather than zero measured FPS. RTT is the peer connection's round-trip time, not a measurement of end-to-end video delay. No target value is presented as measured FPS. With no viewer or no available RTP samples, frame rate is shown as a dash.

Open **Video and connection details** below the stream to diagnose a real frame-rate drop. On the host, compare capture input, encoded FPS, and sent FPS. On a viewer, compare received frames with decoded FPS. The panel also shows each connection's stream dimensions, codec, encoder/decoder implementation when exposed, average frame processing time, RTT, network bandwidth estimate, quality-limitation reason, and direct/relay route. Unsupported measurements appear as a dash. No IP addresses or TURN credentials are included in this panel.

Low capture input while a video is moving points to capture/source rendering; a large drop between capture input and encoding points toward the encoder or its delivery constraints. A host sending normally with fewer received frames requires checking the media path; frames arriving without decoding point toward the viewer decoder. These readings locate the stage to investigate and do not alone prove one root cause. A low current bitrate does not measure a connection's maximum upload/download capacity, and a moderate RTT does not rule out packet loss or limited throughput. Compare host and viewer readings from the same moving scene. WebRTC reports CPU and bandwidth constraints through its [quality limitation statistics](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-qualitylimitationreason).

The architecture is a six-person full mesh (host plus five guests). The host sends a separate screen stream to each viewer. Automatic/native quality can use substantial upload and encoder resources. As an example, five 25 Mbps screen streams require around 125 Mbps of screen-video upload, plus camera/audio/transport overhead. This is intended for small groups rather than broadcast-scale meetings.

Validated on November 8, 2026: a real animated Windows test window on a 144 Hz display was encoded and decoded at its full captured size of 1182 × 702 with a 120 FPS target. A controlled run averaged 116.2 FPS; a later run of the final application averaged about 100 FPS with peaks around 107 FPS. Both encoder and viewer ran on the same computer. This verifies high-frame-rate operation for the tested window, and also shows that sustained performance varies. It does not certify 1080p/4K at 120 FPS. The benchmark left system audio, camera, and microphone off. Reproduce with `node tools/native-benchmark.cjs`; actual encoded dimensions, samples, and machine context are in `artifacts/native-webrtc-benchmark.json` and `artifacts/native-webrtc-benchmark-auto-fixed-resolution.json`.

Latest full-HD verification: Automatic mode at a 240 FPS target encoded and decoded **1920 × 1080 at about 124 FPS on average** with the NVIDIA H.264 Media Foundation hardware encoder. The generated source updated every 8 ms (about 125 updates/second), the display was 144 Hz, and host/viewer shared one computer with a direct local media path. This verifies genuine full-HD throughput above 100 FPS for that setup, not sustained 240 FPS, internet performance, or 4K performance. The measured artifact is `artifacts/native-webrtc-benchmark-native-display-size-240fps.json`. Reproduce in PowerShell with `$env:BENCH_FULL_DISPLAY='1'; $env:BENCH_FPS='240'; node tools/native-benchmark.cjs`.

Screen senders request `maintain-framerate-and-resolution` to avoid unnecessary automatic pixel reduction. If an older browser rejects that preference, the app falls back to `maintain-framerate` and explains that resolution can decrease. An optional manually selected bitrate ceiling still applies. Automatic mode lets WebRTC use available bandwidth; it does not create bandwidth or unlimited encoder capacity. Inadequate hardware or bandwidth can still reduce image fidelity or delivered frames, and the live counters show those limits. No software can guarantee native 4K and 240 FPS on every system and connection.

## Browser content and sound

Share a display or browser window to show ordinary YouTube videos, websites, applications, and games. Browser edition can also use the browser's native tab picker and tab audio when supported.

DRM-protected content, including Netflix and some paid YouTube content, can appear black or omit audio. Together does not bypass DRM and does not guarantee capture of every browser or service. There is no Netflix integration or synchronized per-account playback feature.

System audio is computer output, not just the chosen window's sound. Together requests `restrictOwnAudio:true` to exclude its own conference playback and prevent digital talkback echo. The included Electron 45 runtime contains the Windows fix for that option. Windows 11 is the recommended target. If the captured track does not confirm exclusion, the app reports the limitation. Share a browser tab with tab audio in the browser edition if digital echo occurs. Headphones help with acoustic feedback, but cannot fix recaptured system sound by themselves. Microphones request echo cancellation and noise suppression.

## Use over the internet

The easiest option is to keep your own PC as the server. In the Windows app, choose **Start internet room · free**. The bundled official Cloudflare helper opens a temporary HTTPS address without an account, domain, router changes, or port forwarding. After it says Internet server address, copy the NEW meeting code or invite link. Send the EXE and full public code to your friends; browser guests can instead open the HTTPS invite link. Your camera, microphone, and screen are still off until you choose to enable them.

Keep Together and your PC running. The address changes each time the tunnel starts, and stopping it disconnects guests using it. It exposes Together's HTTP/WebSocket service only, not arbitrary PC services. Quick Tunnels have no uptime guarantee and are intended for testing/small temporary sessions. Cloudflare's terms and availability apply. The app starts no tunnel automatically. See [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

The bundled internet button uses an accountless free Quick Tunnel. This build does not create a cloud account, attach a payment method, subscribe to TURN, or switch to a paid service. Provider request-limit responses, payment-required responses, and explicit quota/trial refusals stop the tunnel and display a persistent explanation. The host checks its public endpoint every 30 seconds for these refusals; ordinary network errors are not falsely described as an expired allowance. No paid fallback is started. Cloudflare documents a 200 in-flight request limit and no uptime guarantee for Quick Tunnels; it does not describe this accountless service as the separate monthly TURN bandwidth allowance. Your ISP/mobile data allowance and electricity remain your own. There is no external account quota API connected to this app and no promise to predict an unreported provider limit before it happens.

This gives your signaling server a public address; WebRTC media still needs a network path between participants. Some restrictive NATs/firewalls require a TURN relay. No TURN subscription or unlimited relay bandwidth is bundled. If people can join the room but media cannot connect, configure TURN as below or use an existing VPN network between the participants.

For a separate free server, deploy the project to a free Render web service. A `render.yaml` blueprint and Dockerfile are included. Push the source to your own Git repository, connect it in Render, select the Free plan, and use the resulting HTTPS `onrender.com` origin as the server URL in Together. Free services sleep after 15 minutes without incoming HTTP/WebSocket traffic, take time to wake, and may restart; your PC does not need to host signaling in that setup. See [Render free service limits](https://render.com/docs/free). Cloud-provider account setup is performed by you; no account or deployment was created automatically.

For manual hosting, run the included Node service on a reachable server, put it behind HTTPS with WebSocket upgrades enabled, and configure TURN when needed:

```powershell
npm ci
$env:PORT = '4317'
$env:PUBLIC_URL = 'https://together.example.com'
$env:TURN_URLS = 'turn:turn.example.com:3478,turns:turn.example.com:5349'
$env:TURN_USERNAME = 'your-relay-user'
$env:TURN_PASSWORD = 'your-relay-password'
npm run server
```

Alternatively use `TURN_SECRET` with a coturn `use-auth-secret` setup to generate temporary HMAC credentials. See `.env.example` for supported variables. The server reads actual environment variables; it does not load a `.env` file automatically. The included Dockerfile exposes port 4317 and runs as a non-root user. Deploy one Node instance: room state is held in memory and is not shared across replicas. Restarting the server ends its rooms.

In each desktop client, expand **Connection & internet setup** and set **Signaling server URL** to that HTTPS origin before creating the room. Copied codes then include the public origin and guests can paste them directly. Browser guests use that HTTPS website. The server must allow WebSocket connections at `/ws`. Desktop loopback origins and same-host browser origins are allowed by default; optional `ALLOWED_ORIGINS` accepts a comma-separated list of extra browser origins.

The Node service forwards signaling and chat only. Media is encrypted by WebRTC between participants (or passes through your TURN relay as encrypted traffic). Anyone with the full room code can join, up to the room limit. There is no waiting room, account system, persistent chat, recording, or host reconnection. Treat internet hosting as a small-group self-hosted service; production abuse controls and a commercial identity system would be additional work.

## Develop and build

Node 22 or newer is recommended.
Building the Windows EXE also uses Python 3 and the Windows .NET Framework C# compiler. Running the finished EXE does not require Python or Node.

```powershell
npm ci
& powershell -ExecutionPolicy Bypass -File tools/fetch-tunnel.ps1
node tools/create-icon.cjs
npm start
```

Build a Windows portable executable:

```powershell
npm run build
```

Validation:

```powershell
npm test
npm run install:browsers
npm run test:ui
node tools/native-smoke.cjs
```

The native smoke test leaves real camera/microphone devices off and captures a generated test-pattern window only. It does not capture the user's desktop. Browser integration tests establish real WebRTC connections among three peers, send synthetic screen video/audio plus fake camera/mic media, and verify delivery, device toggles, joining, chat, and cleanup. Synthetic FPS is reported separately and does not certify physical desktop capture performance.

Code locations: `desktop/` is the sandboxed Electron shell and narrow preload bridge; `server.cjs` is the HTTP/WebSocket room service; `public/engine.js` owns four negotiated screen/audio/camera/microphone slots per peer; `public/app.js` binds controls and devices; `test/` contains backend and browser integration checks.

Build/test wrappers set temporary files and caches to `.build-temp` and `.cache` inside this project. The source build uses the Electron distribution in `node_modules/electron/dist`, then embeds a ZIP payload in the Windows launcher. `tools/PortableLauncher.cs` is the launcher source. The former NSIS launcher, which extracted to the Windows temporary directory, is no longer used.

Primary technical references: [Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer/), [Electron45 own-audio exclusion fix](https://www.electronjs.org/blog/electron-45-0), [WebRTC sender frame-rate and bitrate controls](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters).
