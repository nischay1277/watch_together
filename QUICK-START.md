For the integrated first-time installer, sign-in, network selector and combined party invitation, follow [SETUP.md](SETUP.md). Windows and browser approvals still require you.

For saved friend parties, use [PARTIES.md](PARTIES.md): enter your name and party name, create once, then friends reuse the same invite. Together now checks Tailscale inside the app; no separate Tailscale window is needed when its background connection is running. Choose Smooth motion for weaker internet.

The temporary-room instructions below still apply to Create a room.

Close the old version. Keep **Together-1.4.0-Windows.exe** on D: and open it. Its extracted app, profile, caches, and temporary files stay in **Together-data** beside the EXE. Friends can put their copy on their own drive with space.

1. Host: enter a name → **Create a room** → **Copy code**.
2. Friend: enter a name → paste the full meeting code → **Join**.
3. Anyone: leave **Share computer sound** checked → **Share screen** → **Entire screen · all apps** or **One application window**.
4. Everyone: use the microphone and camera buttons to talk and see each other.

For friends in a different place: choose **Start internet room · free**, wait for the public address, then copy the NEW code containing `trycloudflare.com`. Share the EXE and that full code. Keep this PC and Together running. A `192.168…` code works only on the local network or an existing VPN. Some networks still require a TURN relay; see [the full guide](README.md#use-over-the-internet).

To open directly in Together, every friend must run the new EXE once, then use **Copy direct app link** or the web invite's **Open in Together app** button. Approve the browser's **Open Together** prompt if shown. Invites now show **Join this room** and cannot accidentally create a new room. Everyone should update to 1.3.0; after restarting the host, share a fresh invite.

Click the fullscreen icon or double-click the stream; **F** toggles fullscreen and **Esc** exits. Microphone/camera voice prompts and tones can be changed under **Device confirmation sounds**.

Choose **Source detail**, **Original/source resolution** and **Automatic · best available** to retain source targets without an app-imposed bitrate cap. Smooth motion and Balanced instead use adaptive sender limits for weaker links. Requested FPS still depends on the source, hardware, and network. A 1080p source cannot become true 4K; the quality panel shows actual capture and delivery. DRM-protected Netflix and other video may appear black.

Keep the meeting code private. The host leaving ends the meeting for everyone. Rooms support six people.

If FPS drops, open **Video and connection details** under the stream on both PCs while the same video is moving. The host shows capture input → encoded → sent FPS; the viewer shows received → decoded FPS. Failed peers no longer force a working stream's counter to zero. For a video whose YouTube Stats for nerds says `3840x2160@60`, use a 60 FPS target; the source video is 60 FPS even if its title says 120. A screen capture still contains only the pixels actually rendered by the chosen screen/window.

For high-frame-rate content, keep **Video codec: Automatic**, **Original/source resolution**, and **Automatic bandwidth**. Version 1.1.2 actively selects an accelerated negotiated encoder where available. A controlled full-HD test delivered about **124 FPS** using NVIDIA H.264 hardware; 240 FPS remains a target and depends on the source, display, hardware, and connection. In Video and connection details, check the actual codec/encoder instead of assuming a dropdown guarantees it.

The internet button uses a free public tunnel with no account or paid fallback. If the provider reports a limit or requests payment, the tunnel stops and the app explains why. No paid TURN relay or usage-based hosting account is configured by this build. Your normal internet data allowance still applies.


## Anyone can share (1.2.0)

Update the server/hosting PC and all desktop participants to version 1.2.0, then create a fresh room and invite. Browser users refresh the new server page. Any member can click Share screen and choose a monitor, window, or browser tab (where supported), including computer/tab audio. One screen is active at a time: the current presenter clicks Stop sharing before someone else starts. The server rejects simultaneous starts without replacing an existing stream. The person sharing controls its quality; viewers see the stream actually received. Cameras and microphones keep working during handoff. A guest leaving frees the screen; the original room host leaving still ends the room.

This update does not configure a TURN relay or fix failed cross-network media connectivity. The free public tunnel remains signaling only, and no paid service is added.

For two desktop apps that cannot connect directly, follow [PRIVATE-NETWORK.md](PRIVATE-NETWORK.md). After both PCs join the same free Tailscale Personal network, enable Use private-network invites on the room creator and send a new full code. Reconnect media retries failed peers without turning devices on again. The private-network setup must be completed before that route can be tested.
