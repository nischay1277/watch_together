# Validation — November 8, 2026

- Backend: all seven integration tests passed, including authenticated room codes, cross-room rejection, signaling, chat, room limits, host permissions, and public-origin revocation.
- Browser: all three integration tests passed, including three real WebRTC participants, screen audio/video, two-way cameras and microphones, camera-off voice playback, late joining, chat, device toggles, full received screen resolution, and cleanup.
- Windows: the packaged app passed native source selection and capture of a generated test window. Real camera/microphone devices were left off.
- Exact portable executable: launch, room creation, native source selection, window capture, stopping, and leaving all passed. The test app closed afterward.
- High frame rate: a real 1182 × 702 window on a 144 Hz display was encoded/decoded at full resolution with a 120 FPS target. A controlled run averaged about 116 FPS; the final application run averaged about 100 FPS and peaked around 107 FPS. Encoder and viewer shared the same computer. These results do not guarantee 1080p/4K at 120 FPS or equivalent internet performance.
- Layout: inspected at 1510 × 990, 1000 × 730, and 390 × 844 without overflow or page errors.

## Version 1.1.0 checks

- The native Windows app entered stage fullscreen, filled the viewport, and exited with Escape. The browser fullscreen test also passed.
- The picker exposed entire-monitor sources on its default Entire screen tab, and captured only the generated fixture on the One application window tab during tests. No user's desktop was captured in the test.
- Live quality changes reduced capture below 720 pixels high and then restored it to the available source size when 4K was requested. The panel explained that this source could not supply true 4K. FPS status updated immediately to the new target.
- Microphone/camera activation and microphone mute feedback events produced the correct phrases in the browser UI tests. Tones are generated locally and voice prompts use the system speech engine.
- A real temporary Cloudflare tunnel passed public HTTPS, secure WebSocket, and meeting-code join checks. The desktop Start internet room button and public-code replacement were also verified. All test tunnels stopped afterward.
- Public-address readiness waits for the temporary hostname to resolve and the actual Together health endpoint to respond. This avoids presenting a new DNS name before it works.

Cross-network WebRTC media still depends on participant NAT/firewall behavior; these public tests verify signaling, not every possible remote network. A TURN relay can still be needed.

## Native quality and storage

- Original/source resolution and Automatic/best-available bandwidth are now the defaults. The browser integration test verified the source dimensions were retained and the screen sender had no app-imposed maxBitrate value.
- The final single-file Windows launcher reported its profile/data root beneath `Together-data` beside the portable EXE, and its extracted runtime was confirmed there.
- The exact launcher passed version/default checks, public-address start/stop, room creation, native test-window capture, stopping, and leaving. All test windows and tunnels closed afterward.
- Build caches, test browsers/profiles, temporary files, and application data are directed to D:. Approximately 750 MB of task-created browser downloads were relocated from C: after copy verification. The new launcher no longer uses NSIS/Windows TEMP for bulk extraction.
- Retaining native dimensions and requesting a frame rate do not guarantee lossless video or a sustained FPS beyond the source, encoder, display, or network's capacity. Those limits remain visible in measured stream statistics.

## Version 1.1.1 invitation routing

- Ten backend/parser tests passed, including legacy URL redirects and strict app-link validation.
- Four browser UI checks passed. Live host/guest fixtures confirmed a clicked invite joins the host's exact room; its app handoff preserves the server and case-sensitive code. Invites hide Create and pin the supplied server.
- Native cold-start and already-running app-link tests passed using two isolated host rooms. The app joined the supplied room instead of its own local server, and deferred a second-room invite until the guest left the current room.
- A reported live tunnel answered health checks, while its legacy `/ROOMCODE` URL returned 404. Its corrected fragment invite identified the expected host room. This identified the routing and invitation-flow issue; no user camera, microphone, screen, or chat was used in that check. Real room identifiers are omitted from this public report.
- Windows app-link registration happens when a normal packaged EXE is run. Automated tests skip registering the production protocol to avoid replacing a user's existing handler; a friend must run the updated EXE once, and the browser can still require an Open app confirmation.
- The final one-file 1.1.1 launcher received a custom app URI intact, displayed its exact server and room, and kept Create hidden. A temporary QA Windows URL scheme was registered against that exact EXE, verified as the handler, and removed afterward. Public-address start/stop and controlled-window capture also passed. Production handler registration remains a normal first-run action.

The startup error seen during development came from the benchmark reloading the page before initial navigation completed. That reload was removed. The final portable launch check passed.

Native media capture and encoded/decoded resolution are recorded in the benchmark JSON artifacts. The hardware loopback path is implemented using Electron's Windows API; stream-audio delivery was verified with synthetic audio in the browser media tests. DRM-protected playback is not guaranteed.

## Version 1.1.2 frame-rate diagnosis

- All 24 backend/parser/encoder/telemetry/free-service tests passed. New cases cover accelerated codec selection and caching, unsupported legacy sender APIs, negotiated-codec restrictions, screen-only initial bitrate hints, provider-limit shutdown, healthy streams alongside failed peers, inactive RTP reports, stopped sharing, distinct capture/encode rates, and encoder/decoder stalls.
- All five browser integration tests passed, including real three-peer media, measured capture/sent/received/frame-processing statistics, and a live H.264 switch verified from the codec actually decoded by both viewers.
- The stream details now expose per-peer capture input, encoding, transmission/reception, decoding, codec implementation, dimensions, frame-processing time, RTT, available-send estimate, reported quality constraints, and direct/relay route where supported. Missing measurements remain dashes. Failed/disconnected peers cannot zero a healthy stream's aggregate FPS.
- Two generated moving-window tests preserved their full captured sizes (1922 × 1020 and 1920 × 1018) with a 120 FPS target and automatic bandwidth. Measured encoding/decoding averages varied from about 69 to 105 FPS on the same PC. The actual codec was VP8/libvpx in both runs, including the run that requested H.264; the selected preference alone does not prove which codec was negotiated. These results establish no fixed 30 FPS ceiling and do not establish the cause of a separate remote viewer's drop.
- The new details panel was verified to display real capture, encoding, sent FPS, actual codec, dimensions, and connection route in the native media test. No user screen or real microphone/camera was captured.
- Viewers no longer see their saved local quality dropdowns as if they represented the host's targets. Their panel shows actual received quality, while the host's control explicitly says FRAME RATE TARGET. The role-specific UI check passed.
- Active encoder selection and a bounded startup-bandwidth hint fixed the reproduced software-codec preference issue and hardware startup starvation. Automatic mode at a 240 FPS target delivered full 1920 × 1080 through the NVIDIA H.264 Media Foundation hardware encoder at **124.0 FPS encoded and 124.0 FPS decoded on average**, with peaks around 125 FPS. The source changed every 8 ms and the display was 144 Hz; the test does not prove sustained 240 FPS, 4K, or a remote internet path. Host/viewer were on the same computer. See `artifacts/native-webrtc-benchmark-native-display-size-240fps.json`.
- A provider HTTP 429 test verified the tunnel process is stopped, the public address is cleared, and the error explicitly reports no paid service was started. Payment/expiry refusals are identified without falsely labeling ordinary DNS failures or HTTP 403 as an expired quota. Normal operation uses accountless Cloudflare Quick Tunnels; no paid server or TURN account was provisioned.
- The final one-file 1.1.2 EXE passed cold app-link delivery, D:-based data storage, public-address start/stop, room creation, native generated-window capture, a separate viewer join, actual H.264 hardware encoding/decoding, visible host/viewer diagnostics, stopping, and leaving. The 16 ms animation correctly delivered about 60 FPS in this smoke test; the separate 8 ms full-HD benchmark above establishes the high-FPS result. Test windows, browsers, and tunnels closed afterward.
- The free public tunnel passed real HTTPS, secure WebSocket, and exact meeting-code joining checks after the limit-handling changes. The tunnel was stopped after the test.

The supplied YouTube screenshot reports 3840 × 2160 at 60 FPS, independently of the video's 120 FPS graphic. That describes the decoded YouTube source; a 1080p screen/window still only renders a 1080p-sized capture. The viewer's 9/32 FPS and 2.1/4.1 Mbps screenshots alone cannot establish whether upload, packet delivery, capture, encoding, or decoding is responsible. No cross-network performance guarantee or new TURN relay is included in this update.

## Browser-video capture follow-up

A fixed four-second, 240-frame, 1920 × 1080 VP9 reference video was generated locally at 60 FPS. Unlike the earlier changing-canvas benchmark, this tests playback in a separate browser window with ordinary background behavior. No user's desktop or video service was captured.

- Source playback measured approximately 59.9 FPS with no new dropped frames in the baseline windows.
- Windows browser-window capture delivered approximately 30.1–30.7 encoded/decoded FPS at 1904 × 1072, despite a 240 FPS target and active NVIDIA H.264 hardware encoding. The local RTT was approximately 1–2 ms and the encoder reported no CPU/bandwidth limitation. This reproduces a browser-window capture bottleneck independently of a remote internet path.
- Covering the browser made little difference in this controlled comparison. The experimental GPU-texture capture flag also did not resolve it and was NOT enabled in the distributed application.
- Direct browser-tab capture of the same reference delivered approximately 59.4–59.8 encoded/decoded FPS at the tab's native 1902 × 962 dimensions, with source playback near 60 FPS. Window dimensions include browser chrome; tab dimensions exclude it. Both tests retained their source's captured size. The browser-host route used D3D12 H.264 hardware encoding.
- The packaged 1.1.2 EXE has not changed in this follow-up. Arbitrary native-window capture is still unresolved. Existing browser hosting provides the tested alternative described in `release/BROWSER-HOST.md`.

Reproduction scripts: `tools/create-video-fixture.py` and `tools/browser-capture-benchmark.cjs`. Set `BENCH_TAB=1` for tab capture or `BENCH_TEXTURE=1` for the experimental comparison. Results are in `artifacts/browser-window-capture.json`, `artifacts/browser-window-capture-gpu-texture.json`, and `artifacts/browser-window-capture-tab.json`. All test windows and browsers closed afterward.

## Version 1.2.0 participant sharing and connection recovery

- Any member may present one screen with system/tab audio. The server serializes claims and rejects competing starts. Abandoned starts expire; a guest disconnect releases the screen; only the original room host leaving ends the room.
- Backend checks cover guest screen/audio permissions, simultaneous claims, authenticated recovery messages, private-adapter selection, bounded retry budgets, retry coalescing, cleanup, manual reconnect, and preserving healthy peers. Thirty-one backend/unit checks passed.
- UI/media checks cover the guest Share screen button, native-style capture stub, remote playback, presenter-specific quality controls, stop, host/guest handoff, screen audio reception by other viewers and late joiners, and live camera/microphone tracks during handoff.
- A real WebRTC ICE restart changed ICE credentials while preserving the existing screen/audio tracks and media delivery. Camera, microphone, and screen capture are never opened by the retry mechanism.
- A synthetic native bridge verified that a private HTTP invite selects the detected private origin and does not start a public tunnel. Tailscale adapter detection and HTTP code formatting are tested; this is not a cross-network Tailscale certification.
- All build/test data remains on D:. No private-network software, external account, paid server, or TURN relay was installed or provisioned. Both users still need to connect the private network and verify their actual media path. The known native browser-window FPS limitation remains.
- All seven browser/media checks passed across the UI suite and the real three-peer transport test, including guest-presenter late join and a live ICE restart that preserved track identities.
- The packaged Windows guest passed native source selection and generated-window screen sharing to a browser host, correct presenter routing, stop, and leaving without ending the host's room. Real microphone/camera devices were kept off.
- The final one-file 1.2.0 EXE passed launch, D:-based data location, room creation, generated-window capture, remote playback/telemetry, stop, and leaving. Test apps, browsers, and capture fixtures closed afterward.

## Version 1.3.0 friend parties and adaptive streaming

- 55 backend/unit checks passed, including persistent parties, secret-protected presence, server restart/code restoration, host-role transfer, safe local favorites, stable/collision-fallback ports, redacted Tailscale status and fixed CLI arguments, encoder settings, packet-loss stream isolation, adaptation hysteresis and source preservation.
- All 10 app UI checks passed: named party creation, saving incoming invites, automatic persistence on join, live member names, empty-party rejoining, one-time network authentication guidance, streaming priority persistence, plus existing camera/microphone/chat/guest screen and invite flows.
- Both real browser transport checks passed. The constrained-stream fixture used a 1 Mbps ceiling: the receiver obtained reduced-resolution frames while screen audio, camera and microphone RTP continued. The original canvas capture stayed 1920 pixels wide. This is a controlled sender-budget test, not a measurement of an actual weak home internet connection.
- The existing multi-peer synthetic transport and guest presenter handoff checks passed. Synthetic high-frame-rate samples are not evidence of Netflix/Twitch/native window capture performance.
- Source and packaged Windows party smoke checks passed stable-port restart, server party code restoration, desktop favorites IPC, live presence and one-click rejoin. The installed Tailscale service reported connected outside the test sandbox. No real camera, microphone or personal desktop was captured by these party checks.
- Desktop/compact/mobile layouts were visually inspected at 1510x990, 1000x730 and 390x844. No page errors or horizontal overflow were found. Network screenshot uses a safe test bridge; party presence used real local signaling peers.
- Saved parties require the original server PC to keep Together running. Presence is only for known saved invitations. No public identity directory, paid server or TURN provisioning was added. Both PCs still need the same private network and a usable media route; a two-household connection and the known browser-window capture FPS issue are not certified by this release.
- Build/test caches and artifacts remain on D:. Existing third-party Tailscale installation and Windows service storage were not relocated.
- The exact one-file 1.3.0 portable EXE passed isolated-profile launch, D:-based storage, room creation, generated-window capture, receiver playback and telemetry, stop, leaving and clean shutdown. This local fixture is not a cross-network FPS result.

## Version 1.4.0 integrated first-time connection setup

- Added an in-app setup panel for official MSI installation, browser authentication, progress polling, network invitation acceptance, saved-network selection and combined first-time party/network invites. Account and Windows installation approvals remain user-controlled.
- 63 unit/server checks passed. Installer tests cover fixed official versioned MSI paths, bounded downloads, provider/redirect failures, publisher-verification failure, deduplicated installation requests and no startup installation. Profile tests permit switching only to a freshly listed profile ID; invitation tests allow only exact official invite URLs.
- All 16 browser/media checks passed, including mocked first-time install/sign-in, explicit invitation acceptance, joining the exact party, copying a combined invite, preserving ordinary invites, selecting networks in Together and prohibiting network switching during an active party. After adding action coalescing, the five affected setup checks passed again.
- The native app downloaded the real official Tailscale MSI on D: and verified its valid Tailscale Windows publisher signature. Installer execution was replaced with a no-op: no installation or account enrollment was performed. The verifier loads the Windows PowerShell security module explicitly to avoid incompatible inherited PowerShell 7 module paths.
- Native source and packaged setup panels passed actual background-service status and layout checks with devices off. Packaged saved-party restart/presence/one-click rejoin checks also passed. No user's network was switched by tests; profile changes and browser approvals used mocks.
- A fresh-PC installation, a real friend's enrollment/approval and an end-to-end two-household stream are not claimed as validated. Browser authentication and Tailscale membership/device approval cannot be silently completed by Together. The separate native browser-window FPS limitation remains.
- Download and requested helper installation paths are beside Together on D:. Windows can still use C: for drivers, installer metadata and system temporary files. No paid relay, account API key, billing change or paid fallback was added.
- The exact 1.4.0 portable EXE passed D:-based isolated launch, generated-window screen capture, receiver playback and telemetry, stopping, leaving and clean shutdown. This is local fixture coverage, not a claim of high-FPS delivery between separate households.
