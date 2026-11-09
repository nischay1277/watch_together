const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');

async function bootstrap(page, name) {
  await page.goto('/');
  await page.evaluate(async (displayName) => {
    const { MeetingEngine } = await import('/engine.js');
    window.engineEvents = [];
    window.engineStreams = { screen: null, participants: {} };
    window.fpsSamples = [];
    const sinks = new Map();
    const sink = (key, stream) => {
      let video = sinks.get(key);
      if (!video) {
        video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.style.cssText = 'position:fixed;bottom:0;left:0;width:8px;height:8px;opacity:.01;pointer-events:none';
        document.body.append(video);
        sinks.set(key, video);
      }
      video.srcObject = stream;
      if (stream) void video.play().catch(() => {});
    };
    window.e = new MeetingEngine({
      serverUrl: location.origin,
      name: displayName,
      settings: { fps: 120, resolution: 720, bitrate: 8, codec: 'auto' },
      onEvent(type, data) {
        if (type === 'screen') {
          window.engineStreams.screen = data.stream;
          sink('screen', data.stream);
        } else if (type === 'participant-stream') {
          window.engineStreams.participants[data.peerId] = data.stream;
          sink(data.peerId, data.stream);
        } else if (type === 'stats') {
          window.fpsSamples.push(data);
        }
        if (type !== 'stats' && type !== 'screen' && type !== 'participant-stream') {
          window.engineEvents.push({ type, data });
        }
      },
    });
    window.inboundRows = async () => {
      const rows = [];
      for (const peer of window.e._peers.values()) {
        const reports = await peer.pc.getStats();
        reports.forEach(report => {
          if (report.type === 'inbound-rtp') rows.push({
            peerId: peer.id,
            mid: report.mid,
            kind: report.kind || report.mediaType,
            bytes: report.bytesReceived || 0,
            frames: report.framesDecoded || 0,
            width: report.frameWidth,
            height: report.frameHeight,
            codec: reports.get(report.codecId)?.mimeType,
          });
        });
      }
      return rows;
    };
  }, name);
}

async function enableConversation(page) {
  await page.evaluate(async () => {
    await Promise.all([window.e.setCamera(true), window.e.setMicrophone(true)]);
  });
}

async function startSyntheticScreen(page) {
  await page.evaluate(async () => {
    if (window.syntheticTimer) clearInterval(window.syntheticTimer);
    if (window.syntheticAudio) await window.syntheticAudio.close();
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    let frame = 0;
    const draw = () => {
      const tick = frame++;
      context.fillStyle = `hsl(${tick % 360} 60% 25%)`;
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = '#f4f2dc';
      context.fillRect((tick * 7) % 580, 90, 60, 180);
      context.font = '36px monospace';
      context.fillText(`SYNTHETIC ${tick}`, 20, 50);
    };
    draw();
    window.syntheticTimer = setInterval(draw, 8);
    const stream = canvas.captureStream(120);
    const audio = new AudioContext();
    window.syntheticAudio = audio;
    const destination = audio.createMediaStreamDestination();
    const oscillator = audio.createOscillator();
    oscillator.frequency.value = 440;
    const gain = audio.createGain();
    gain.gain.value = 0.1;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    await audio.resume();
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    window.syntheticCanvas = canvas;
    await window.e.setScreen(stream);
  });
}

async function expectInbound(page, peerId, slots) {
  await expect.poll(async () => page.evaluate(async ({ id, wanted }) => {
    const rows = await window.inboundRows();
    return wanted.every(slot => rows.some(row => row.peerId === id && row.mid === String(slot)
      && row.bytes > 0 && (row.kind === 'audio' || row.frames > 0)));
  }, { id: peerId, wanted: slots }), { timeout: 25000, message: `Real received RTP for peer ${peerId}, slots ${slots.join(',')}` }).toBe(true);
}

test('meeting code, real screen/audio, two-way cameras/mics, late join, toggles, and cleanup', async ({ browser }, testInfo) => {
  test.setTimeout(120000);
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const host = await context.newPage();
  const guest = await context.newPage();
  const lateGuest = await context.newPage();
  try {
    await Promise.all([bootstrap(host, 'Host'), bootstrap(guest, 'First viewer'), bootstrap(lateGuest, 'Late viewer')]);
    const welcome = await host.evaluate(() => window.e.create());
    const joined = await guest.evaluate(code => window.e.join(code), welcome.code);
    await Promise.all([enableConversation(host), enableConversation(guest)]);
    await startSyntheticScreen(host);

    await Promise.all([
      expectInbound(guest, welcome.selfId, [0, 1, 2, 3]),
      expectInbound(host, joined.selfId, [2, 3]),
    ]);
    await expect.poll(() => guest.evaluate(() => window.engineStreams.screen?.getTracks().length || 0)).toBe(2);
    await expect.poll(() => guest.evaluate(id => window.engineStreams.participants[id]?.getTracks().length || 0, welcome.selfId)).toBe(2);
    await expect.poll(() => guest.evaluate(async id => {
      const row = (await window.inboundRows()).find(row => row.peerId === id && row.mid === '0');
      return row ? `${row.width}x${row.height}` : '';
    }, welcome.selfId)).toBe('640x360');
    await host.evaluate(() => window.e.updateSettings({ resolution: 0, bitrate: 0 }));
    expect(await host.evaluate(() => [...window.e._peers.values()].every(peer => peer.transceivers[0].sender.getParameters().encodings.every(encoding => encoding.maxBitrate === undefined)))).toBe(true);

    const originalTracks = await guest.evaluate(() => ({
      camera: window.e.cameraStream.getVideoTracks()[0].id,
      microphone: window.e.microphoneStream.getAudioTracks()[0].id,
    }));
    await guest.evaluate(async () => {
      window.previousLocalTracks = [...window.e.cameraStream.getTracks(), ...window.e.microphoneStream.getTracks()];
      await Promise.all([window.e.setCamera(false), window.e.setMicrophone(false)]);
    });
    await expect.poll(() => host.evaluate(id => {
      const member = window.e.members.find(person => person.id === id);
      return Boolean(member && !member.media.camera && !member.media.microphone);
    }, joined.selfId)).toBe(true);
    expect(await guest.evaluate(() => window.previousLocalTracks.every(track => track.readyState === 'ended'))).toBe(true);
    await enableConversation(guest);
    const replacementTracks = await guest.evaluate(() => ({
      camera: window.e.cameraStream.getVideoTracks()[0].id,
      microphone: window.e.microphoneStream.getAudioTracks()[0].id,
    }));
    expect(replacementTracks.camera).not.toBe(originalTracks.camera);
    expect(replacementTracks.microphone).not.toBe(originalTracks.microphone);
    await expect.poll(() => host.evaluate(id => {
      const member = window.e.members.find(person => person.id === id);
      return Boolean(member?.media.camera && member.media.microphone);
    }, joined.selfId)).toBe(true);

    const lateJoined = await lateGuest.evaluate(code => window.e.join(code), welcome.code);
    await enableConversation(lateGuest);
    await Promise.all([
      expectInbound(lateGuest, welcome.selfId, [0, 1, 2, 3]),
      expectInbound(lateGuest, joined.selfId, [2, 3]),
      expectInbound(host, lateJoined.selfId, [2, 3]),
      expectInbound(guest, lateJoined.selfId, [2, 3]),
    ]);
    await guest.evaluate(() => window.e.sendChat('The screen and voices are connected.'));
    await expect.poll(() => lateGuest.evaluate(() => window.engineEvents.some(event => event.type === 'chat'
      && event.data.text === 'The screen and voices are connected.'))).toBe(true);

    // Allow several measured one-second samples. This is a changing canvas,
    // not proof of physical desktop capture or a 120 Hz display.
    await expect.poll(() => host.evaluate(() => window.fpsSamples.filter(sample => sample.fps !== null).length), { timeout: 15000 }).toBeGreaterThanOrEqual(3);
    const telemetry = await Promise.all([host, guest, lateGuest].map(page => page.evaluate(() => ({
      name: window.e.name,
      samples: window.fpsSamples,
      errors: window.engineEvents.filter(event => event.type === 'error'),
      maxMeasuredFps: Math.max(0, ...window.fpsSamples.map(sample => sample.fps || 0)),
    }))));
    console.log('Synthetic canvas RTP FPS (not physical desktop verification):', telemetry.map(item => `${item.name}: ${item.maxMeasuredFps}`).join(', '));
    const telemetryPath = testInfo.outputPath('synthetic-webrtc-telemetry.json');
    await fs.writeFile(telemetryPath, JSON.stringify({ source: '640x360 changing canvas, requested 120 FPS, 8ms drawing timer; no desktop FPS guarantee', telemetry }, null, 2));
    await testInfo.attach('synthetic-webrtc-telemetry.json', { path: telemetryPath, contentType: 'application/json' });
    expect(telemetry.flatMap(item => item.errors)).toEqual([]);
    expect(telemetry[0].samples.some(sample => sample.sourceFps > 0 && sample.videoState === 'active'
      && sample.peerStats.some(peer => peer.codec && peer.encodeMs !== null && peer.sentFps > 0))).toBe(true);
    expect(telemetry[1].samples.some(sample => sample.videoState === 'active'
      && sample.peerStats.some(peer => peer.receivedFps > 0 && peer.decodeMs !== null))).toBe(true);

    // A menu preference alone can still negotiate VP8. Verify the codec that
    // really reaches both viewers after the host changes its live encoder.
    await host.evaluate(() => window.e.updateSettings({ codec: 'video/H264' }));
    for (const viewer of [guest, lateGuest]) {
      await expect.poll(() => viewer.evaluate(async id => (await window.inboundRows()).some(row => row.peerId === id
        && row.mid === '0' && row.codec === 'video/H264' && row.frames > 0), welcome.selfId), { timeout: 20000 }).toBe(true);
    }
    await host.evaluate(() => window.e.updateSettings({ codec: 'auto' }));

    await host.evaluate(async () => {
      window.savedScreenTracks = window.e.screenStream.getTracks();
      await window.e.setScreen(null);
    });
    await expect.poll(() => guest.evaluate(() => window.engineStreams.screen === null)).toBe(true);
    expect(await host.evaluate(() => window.savedScreenTracks.every(track => track.readyState === 'ended'))).toBe(true);
    // Replacing the already-negotiated tracks must resume without rejoining.
    await startSyntheticScreen(host);
    await expect.poll(() => guest.evaluate(() => Boolean(window.engineStreams.screen?.getVideoTracks().length))).toBe(true);

    await lateGuest.evaluate(() => {
      window.savedTracks = [...window.e.cameraStream.getTracks(), ...window.e.microphoneStream.getTracks()];
      window.e.close();
    });
    expect(await lateGuest.evaluate(() => window.savedTracks.every(track => track.readyState === 'ended'))).toBe(true);
    await expect.poll(() => host.evaluate(() => window.e.members.length)).toBe(2);
    await host.evaluate(() => window.e.close());
    await expect.poll(() => guest.evaluate(() => window.engineEvents.some(event => event.type === 'ended'))).toBe(true);
    expect(await guest.evaluate(() => window.e.cameraStream === null && window.e.microphoneStream === null && window.e._peers.size === 0)).toBe(true);
  } catch (error) {
    const diagnostics = await Promise.all([host, guest, lateGuest].map(page => page.evaluate(async () => ({
      name: window.e?.name,
      events: window.engineEvents,
      inbound: window.inboundRows ? await window.inboundRows() : [],
      peers: [...(window.e?._peers.values() || [])].map(peer => ({
        id: peer.id,
        connection: peer.pc.connectionState,
        signaling: peer.pc.signalingState,
        ice: peer.pc.iceConnectionState,
        transceivers: peer.pc.getTransceivers().map(item => ({
          mid: item.mid, direction: item.direction, currentDirection: item.currentDirection,
          sender: item.sender.track ? { kind: item.sender.track.kind, ready: item.sender.track.readyState, enabled: item.sender.track.enabled } : null,
          receiver: { kind: item.receiver.track.kind, muted: item.receiver.track.muted, ready: item.receiver.track.readyState },
        })),
      })),
    })).catch(() => null)));
    console.log('Engine failure diagnostics:', JSON.stringify(diagnostics));
    await testInfo.attach('engine-failure-diagnostics.json', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' });
    throw error;
  } finally {
    await Promise.all([host, guest, lateGuest].map(page => page.evaluate(async () => {
      window.e?.close();
      clearInterval(window.syntheticTimer);
      await window.syntheticAudio?.close().catch(() => {});
    }).catch(() => {})));
    await context.close();
  }
});
