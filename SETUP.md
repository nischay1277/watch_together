# First-time connection setup in Together 1.4

Both people use Together-1.4.0-Windows.exe. Keep the EXE and Together-data folder on D: if that is your chosen drive. Close the old Together version first.

## On the host PC

1. Open Together and choose **Setup and invite a friend** below the private-network connection status.
2. If needed, choose **Install Tailscale**. Together downloads the official MSI to Together-data/Network/Downloads, verifies the Windows signature and Tailscale publisher, and opens Windows Installer. Complete the administrator/installation prompts. The requested program directory stays under Together-data/Network/Tailscale. Windows drivers, installer records and some temporary/system files can still use C:.
3. Choose **Sign in / connect**. Complete the one-time sign-in in your normal browser with your own personal account. Use the Personal/free plan. Together checks progress automatically while the setup panel is open; ordinary connection checks also run in the background without opening another app.
4. Close setup, enter your name and a party name, then choose **Create party**.
5. Reopen **Setup and invite a friend**. Choose **Create network invitation**. In the official Tailscale Users page, choose Invite external users and copy its invitation link. Paste it into the setup panel's Network invitation link field.
6. Choose **Copy first-time party invite** and send it privately to the intended friend. It contains both the current party and that one-time network invitation. Create a separate network invitation for each new friend. Ordinary Copy code and saved-party invites do not include network onboarding.

## On the friend's PC

1. Open Together, enter your name, then paste the complete first-time invite in Meeting code. Together opens the setup panel and keeps the exact party selected.
2. Install the helper and sign in through the panel if needed. Choose **Accept network invitation**, then approve it in the browser with your own account.
3. If the host PC is still missing, expand **Choose your friend's network**. Choose **Add / sign in to a network** if the host's network is not yet on the list, and select it in the browser. Then choose it from Saved networks and click **Use selected network**. Leave an active Together party before changing networks; this can interrupt other private connections too.
4. Choose **Continue to party**. If it is still unreachable, check the host is online and both devices are using the same network. An online network indicator alone does not prove the screen/audio media path is working.

## Later sessions

Open Together and choose the saved party. The Tailscale service runs in the background, so you do not need to open its separate app window each time. Re-authentication can still be needed if the account/device approval expires. Keep the original party server PC and Together running. Sharing, camera and microphone always require your own actions.

## What remains outside Together

Windows must approve installation. Tailscale/your identity provider must approve sign-in, network membership and any device approval. Together does not store your account password or add broad account API credentials. The guided setup cannot silently grant your friend network access. If a provider requests payment, stop rather than upgrading; Together never selects a paid relay or changes billing.

Installation/sign-in failures are shown in the panel. No installer is opened unless the user chooses installation and publisher verification succeeds. Real download/signature validation and mocked first-time installer/account actions were tested; a fresh-machine install, real friend-account enrollment and two-household connection still require those users to complete their approvals.
