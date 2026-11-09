export class DeviceFeedback {
  constructor(mode = () => 'voice') { this.mode = mode; this.audio = null; }
  prime() {
    if (this.mode() === 'off') return;
    try {
      this.audio ||= new (window.AudioContext || window.webkitAudioContext)();
      void this.audio.resume().catch(() => {});
    } catch { /* Feedback never blocks a device control. */ }
  }
  play(kind, enabled) {
    const mode = this.mode();
    if (mode === 'off') return;
    this.prime();
    const phrase = kind === 'camera' ? `Camera ${enabled ? 'activated' : 'deactivated'}` : `Microphone ${enabled ? 'activated' : 'muted'}`;
    if (this.audio) {
      const notes = kind === 'camera' ? (enabled ? [523, 784] : [392, 262]) : (enabled ? [660, 880] : [440, 330]);
      notes.forEach((frequency, index) => {
        const start = this.audio.currentTime + index * 0.13;
        const oscillator = this.audio.createOscillator(), gain = this.audio.createGain();
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.055, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.11);
        oscillator.connect(gain).connect(this.audio.destination);
        oscillator.start(start); oscillator.stop(start + 0.12);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      });
    }
    if (mode === 'voice' && 'speechSynthesis' in window) {
      const voice = new SpeechSynthesisUtterance(phrase);
      voice.lang = 'en-US'; voice.rate = 1.05; voice.volume = 0.8;
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(voice);
    }
    window.dispatchEvent(new CustomEvent('together-device-feedback', { detail: { kind, enabled, phrase, mode } }));
  }
}
