/* Original procedural soundtrack. No media files, external resources or uploads. */
(() => {
  class QuizAudio {
    constructor(onStatus) {
      this.onStatus = onStatus;
      this.timer = setInterval(() => this.tick(), 520);
      this.beat = 0;
      this.active = false;
    }
    async unlock() {
      try {
        if (!this.context) {
          this.context = new AudioContext();
          this.master = this.context.createGain();
          this.master.gain.value = 0;
          const compressor = this.context.createDynamicsCompressor();
          this.master.connect(compressor); compressor.connect(this.context.destination);
        }
        await this.context.resume();
        this.onStatus?.(this.context.state === 'running' ? 'ready' : 'blocked');
      } catch { this.onStatus?.('blocked'); }
    }
    update(state, enabled) {
      const previous = this.state;
      this.state = state;
      this.active = enabled && state.audio.enabled;
      if (this.active && !this.context) this.unlock();
      if (!this.context) return;
      this.master.gain.setTargetAtTime(this.active ? state.audio.volume / 100 * 0.38 : 0, this.context.currentTime, .15);
      if (this.active && this.context.state !== 'running') this.onStatus?.('blocked');
      if (this.active && previous && previous.session === state.session && previous.phase !== state.phase && ['locked', 'correct', 'wrong', 'finished'].includes(state.phase)) this.cue(state.phase);
    }
    tone(frequency, offset, duration, level = .12, type = 'sine') {
      if (!this.active || this.context?.state !== 'running') return;
      const t = this.context.currentTime + offset, oscillator = this.context.createOscillator(), envelope = this.context.createGain();
      oscillator.type = type; oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(0, t); envelope.gain.linearRampToValueAtTime(level, t + .035);
      envelope.gain.exponentialRampToValueAtTime(.0001, t + duration);
      oscillator.connect(envelope); envelope.connect(this.master);
      oscillator.start(t); oscillator.stop(t + duration + .03);
      oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    }
    tick() {
      if (!this.active || !this.state || ['waiting', 'finished', 'wrong'].includes(this.state.phase)) return;
      const locked = this.state.phase === 'locked';
      const notes = locked ? [110, 116.54, 164.81, 116.54] : [110, 164.81, 220, 246.94, 164.81, 130.81, 220, 164.81];
      this.tone(notes[this.beat % notes.length], 0, locked ? .48 : 1.6, locked ? .2 : .09, 'sine');
      if (this.beat % 4 === 0) { this.tone(55, 0, 2, .18); this.tone(82.41, .08, 1.9, .07); }
      if (locked) this.tone(330, .26, .18, .055, 'triangle');
      this.beat++;
    }
    cue(phase) {
      const notes = phase === 'correct' ? [261.63, 329.63, 392, 523.25] : phase === 'wrong' ? [164.81, 155.56, 110, 55] : phase === 'locked' ? [110, 220, 116.54] : this.state.outcome === 'won' ? [261.63, 392, 523.25, 659.25, 783.99] : [220, 164.81, 110];
      notes.forEach((note, i) => this.tone(note, i * .19, 1.2, .18, 'triangle'));
    }
    stop() { this.active = false; if (this.context) this.master.gain.setTargetAtTime(0, this.context.currentTime, .1); }
    destroy() { this.stop(); clearInterval(this.timer); this.context?.close(); }
  }
  window.TChatQuizAudio = QuizAudio;
})();
