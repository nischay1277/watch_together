For the integrated first-time installer, sign-in, network selector and combined party invitation, follow [SETUP.md](SETUP.md). Windows and browser approvals still require you.

# Friend parties in Together 1.4

Keep Together-1.4.0-Windows.exe and its Together-data folder on D:. Both friends should use this version. Parties are hosted on the PC that created them; this PC must keep Together running. There is no central paid party server.

## First time

1. Install Tailscale Personal once on both PCs and invite your friend into the same private network. Use separate logins. Do not select a paid plan. Installation, account approval and the first sign-in still need your participation.
2. Open Together. The private-network panel checks the installed background service automatically. If connected, you do not need to open the Tailscale app. If stopped, choose Connect here. Sign-in opens the official browser page when required.
3. Enter your display name and a party name, then choose Create party. Private-network invites are selected automatically when a Tailscale adapter is available.
4. Copy the complete party invite and send it privately. A friend enters it in Together and joins. Both clients remember the party on their own device.
5. Either friend can share a screen and computer sound. One screen is active at a time. Cameras and microphones are always optional.

## Next time

Open Together and find the party under Your parties. When its server is reachable, the card shows who is there; click Join party. Friends do not need a fresh code for every session. Nobody's camera, microphone or screen starts automatically.

The party remains saved when empty. Leaving a persistent party transfers the participant host role, so other members can continue as long as the original server PC remains running. Ordinary temporary rooms retain their existing host-leaves/room-ends behavior.

The host port is remembered to keep the full invite stable across restarts. If another program takes that port, Together uses a new port and warns that invites need updating. Public Quick Tunnel addresses can also change; use private-network invites for reusable parties. Changing networks or deleting Together-data can invalidate invitations.

Presence is limited to saved parties whose full invitation you possess. There is no public friend directory, account system, or global discovery. Host-offline and unreachable are shown together because the app cannot reliably distinguish them. One friend cannot find another's unknown parties without first receiving an invitation.

## Weak internet

- **Smooth motion:** lowers encoded detail per viewer to help retain motion; on a very weak link it also lowers the frame rate.
- **Balanced:** adjusts detail and frame rate after sustained bandwidth/encoder pressure, then restores quality gradually after recovery.
- **Source detail:** keeps your source-resolution and FPS targets without the app's automatic resolution ladder. WebRTC can still be constrained by hardware and the connection.

Start with a 60 FPS target for 60 FPS video, Original/source resolution, automatic bitrate and automatic codec. Smooth and Balanced apply reasonable automatic bitrate ceilings; selecting a manual limit remains an upper bound. They never force a minimum bitrate or invent frames. Actual received resolution, codec and frame rate remain visible in Stream health.

Automatic adjustment is per screen sender/viewer; it does not lower the capture source for everyone. Camera bandwidth is also reduced while adapting, leaving screen and microphone audio running. This cannot turn a low-bandwidth connection into lossless 1080p60, remove Netflix DRM, or repair the separately documented Windows browser-window capture limit.

## Local data and cost

Saved invites and server party credentials stay in Together-data beside the EXE, separately from source code. Keep that folder private; an invite grants access to its party. Participant names and online state are not written into the server party registry. No password, Tailscale key, subscription, paid relay, or cloud encoder is provisioned by Together. Your normal internet allowance applies.

Tailscale pricing and free-account eligibility can change. If Tailscale requests payment or refuses the free plan, stop setup rather than upgrading. Together's Connect button does not manage billing. A restrictive firewall or relayed private-network path may still prevent smooth streaming.
