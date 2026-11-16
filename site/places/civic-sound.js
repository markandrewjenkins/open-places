// Open Places: tiny synthesised sound cues (WebAudio, no audio files). Off by default; the header's speaker button turns
// them on and the choice is kept in localStorage ("odp-sound" = "on" | "off").
//   tick    a soft click when a topic, leaf or sub-tab is chosen
//   notice  two rising notes (a new alert at level "notice")
//   warn    three firmer notes (level "warn")
//   info    silent
// At most one cue every 3 s (an alert may follow a tick), nothing while the tab is hidden, nothing while muted. Callers
// pass { seed: true } for the first-load state so it stays silent. prefers-reduced-motion is about visuals, so it is not
// read here.

const KEY = "odp-sound";
const GAP = 3000;
const read = () => { try { return localStorage.getItem(KEY) === "on"; } catch { return false; } };
const write = (on) => { try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* storage blocked */ } };

const ICON_ON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke-width="1.6"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
const ICON_OFF = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke-width="1.6"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';

/** button: the header toggle (gets aria-pressed, title and icon). Returns { cue(kind, opts), on() }. */
export function createSound(button) {
  let on = read(), ac = null, last = 0, lastKind = "";

  const audio = () => {
    if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ac = new AC(); }
    if (ac.state === "suspended") ac.resume().catch(() => {});
    return ac;
  };
  // browsers start audio only after a gesture: wake the context on the first click or key once sound is on
  const wake = () => { if (on) audio(); };
  addEventListener("pointerdown", wake, { capture: true, passive: true });
  addEventListener("keydown", wake, { capture: true });

  /** one soft bell-like note: sine + a quiet octave partial, fast attack, exponential decay */
  function note(a, t, freq, dur, vol, type = "sine") {
    const out = a.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = a.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3200;
    out.connect(lp).connect(a.destination);
    for (const [mult, g, ty] of [[1, 1, type], [2, 0.18, "sine"]]) {
      const o = a.createOscillator(), og = a.createGain();
      o.type = ty; o.frequency.setValueAtTime(freq * mult, t); og.gain.value = g;
      o.connect(og).connect(out); o.start(t); o.stop(t + dur + 0.05);
    }
  }
  function play(kind) {
    const a = audio(); if (!a) return;
    const t = a.currentTime + 0.02;
    if (kind === "tick") {
      // a short filtered blip, barely there
      const o = a.createOscillator(), g = a.createGain(), hp = a.createBiquadFilter();
      o.type = "triangle"; o.frequency.setValueAtTime(1850, t); o.frequency.exponentialRampToValueAtTime(1200, t + 0.03);
      hp.type = "highpass"; hp.frequency.value = 700;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.035, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      o.connect(hp).connect(g).connect(a.destination); o.start(t); o.stop(t + 0.06);
    } else if (kind === "notice") {
      note(a, t, 659.25, 0.42, 0.06);          // E5
      note(a, t + 0.14, 987.77, 0.6, 0.05);    // B5
    } else if (kind === "warn") {
      note(a, t, 587.33, 0.32, 0.075, "triangle");        // D5
      note(a, t + 0.13, 739.99, 0.32, 0.075, "triangle"); // F#5
      note(a, t + 0.26, 880, 0.62, 0.07, "triangle");     // A5
    }
  }

  /** kind: "tick" | "notice" | "warn" | "info"; opts.seed = the first-load state (silent) */
  function cue(kind, opts = {}) {
    if (!on || opts.seed || kind === "info" || !["tick", "notice", "warn"].includes(kind)) return false;
    if (document.hidden) return false;
    const now = performance.now();
    // one cue per 3 s; an alert may follow a tick, never the other way round
    if (now - last < GAP && !(kind !== "tick" && lastKind === "tick")) return false;
    last = now; lastKind = kind;
    try { play(kind); } catch { return false; }
    return true;
  }

  function paint() {
    if (!button) return;
    button.innerHTML = on ? ICON_ON : ICON_OFF;
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", "Sound cues");
    button.title = on ? "Sound on" : "Sound off";
  }
  button?.addEventListener("click", () => {
    on = !on; write(on); paint();
    if (on) { audio(); last = 0; cue("tick"); }
  });
  paint();
  return { cue, on: () => on };
}
