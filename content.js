(function () {
  console.log("Intenta content loaded");

  if (document.getElementById("intenta-widget")) return;

  let sessionStateInterval = null;
  let audioCtx = null;
  let audioUnlocked = false;

  function safeSendMessage(message, callback) {
    try {
      if (!chrome.runtime?.id) return;

      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) return;
        if (!chrome.runtime?.id) return;
        if (callback) callback(response);
      });
    } catch {}
  }

  function unlockAudio() {
    if (audioUnlocked) return;

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      const buffer = audioCtx.createBuffer(1, 1, 22050);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start(0);

      audioUnlocked = true;
    } catch {}
  }

  document.addEventListener("click", unlockAudio, { once: true });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "COUNTDOWN_START") {
      playCountdownTicks();
    }

    if (message.type === "SESSION_COMPLETE") {
      showCelebrationOverlay();
      render();
      stopUpdates();
      playSuccessSound();
    }
  });

  const pageData = {
    title: document.title,
    url: window.location.href
  };

  safeSendMessage(
    { type: "PAGE_DATA", data: pageData },
    (response) => {
      if (!response) return;

      if (response.action === "BLOCK") {
        showBlockedOverlay();
      }
    }
  );

  function showBlockedOverlay() {
    const overlay = document.createElement("div");
    overlay.id = "intenta-block-overlay";

    overlay.style = `
      position: fixed;
      top:0;left:0;width:100%;height:100%;
      background: rgba(0,0,0,0.8);
      z-index:999999;
      display:flex;
      align-items:center;
      justify-content:center;
    `;

    overlay.innerHTML = `
      <div style="background:#111;padding:24px;border-radius:10px;color:white;text-align:center;max-width:360px">
        <p style="font-size:20px;font-weight:700;margin:0 0 16px">This site is not part of your focus session.</p>
        <button id="add" style="margin-right:8px">Add to session</button>
        <button id="back">Go back</button>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById("add").onclick = () => {
      safeSendMessage(
        {
          type: "ADD_TO_ALLOWED_SITES",
          data: { domain: window.location.hostname }
        },
        () => {
          overlay.remove();
          window.location.reload();
        }
      );
    };

    document.getElementById("back").onclick = () => {
      window.history.back();
    };
  }

  createWidget();

  function createWidget() {
    const widget = document.createElement("div");
    const badge = document.createElement("div");
    widget.id = "intenta-widget";
    widget.innerHTML = "🧠";

    widget.style = `
      position: fixed;
      bottom:20px;
      right:20px;
      width:50px;
      height:50px;
      background:black;
      color:white;
      border-radius:50%;
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      z-index:999999;
    `;

    document.body.appendChild(widget);

    badge.id = "intenta-timer-badge";
    badge.style = `
      position: fixed;
      bottom: 64px;
      right: 18px;
      color: white;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      display: none;
      z-index: 1000000;
      box-shadow: 0 4px 10px rgba(0,0,0,0.25);
    `;

    document.body.appendChild(badge);

    widget.onclick = togglePanel;
    startUpdates();
  }

  function togglePanel() {
    let panel = document.getElementById("intenta-panel");

    if (panel) {
      panel.remove();
      return;
    }

    panel = document.createElement("div");
    panel.id = "intenta-panel";

    panel.style = `
      position: fixed;
      bottom:80px;
      right:20px;
      background:#1a1a1a;
      color:white;
      padding:15px;
      border-radius:10px;
      z-index:999999;
      width:200px;
    `;

    panel.innerHTML = `
      <div id="sessionStatus">
        <div id="modeText">Mode: IDLE</div>
        <div id="timeText">Remaining: --:--</div>
        <div id="totalText">Total left: --:--:--</div>
      </div>
      <div id="sessionConfig">
        <input id="totalTime" placeholder="Total session (min)" />
        <input id="focusTime" placeholder="Focus (min)" />
        <input id="breakTime" placeholder="Break (min)" />
        <button id="start">Start Session</button>
      </div>
      <button id="stop">Stop</button>
      <button id="tabs">Use Tabs</button>
    `;

    document.body.appendChild(panel);

    document.getElementById("start").onclick = () => {
      const total = Number(document.getElementById("totalTime").value);
      const focus = Number(document.getElementById("focusTime").value);
      const breakTime = Number(document.getElementById("breakTime").value);

      safeSendMessage({
        type: "START_SESSION",
        data: {
          total,
          focus,
          break: breakTime
        }
      });

      render();
      startUpdates();
    };

    document.getElementById("stop").onclick = () => {
      safeSendMessage({ type: "STOP_SESSION" });
      stopUpdates();
      render();
    };

    document.getElementById("tabs").onclick = () => {
      safeSendMessage({ type: "GET_TABS" });
    };

    render();
    startUpdates();
  }

  function startUpdates() {
    if (sessionStateInterval) return;

    sessionStateInterval = setInterval(render, 1000);
  }

  function stopUpdates() {
    if (!sessionStateInterval) return;

    clearInterval(sessionStateInterval);
    sessionStateInterval = null;
  }

  function render() {
    safeSendMessage({ type: "GET_SESSION_STATE" }, (state) => {
      if (!state) return;

      const modeText = document.getElementById("modeText");
      const timeText = document.getElementById("timeText");
      const totalText = document.getElementById("totalText");
      const config = document.getElementById("sessionConfig");
      const start = document.getElementById("start");
      const badge = document.getElementById("intenta-timer-badge");
      const mode = state.active ? state.mode : "IDLE";
      const remaining = format(state.remaining);
      const totalRemaining = formatLong(state.totalRemaining || 0);

      if (modeText) modeText.innerText = "Mode: " + mode;
      if (timeText) timeText.innerText = "Remaining: " + remaining;
      if (totalText) totalText.innerText = "Total left: " + totalRemaining;

      if (config) config.style.display = state.active ? "none" : "block";
      if (start) start.style.display = state.active ? "none" : "";

      if (badge) {
        if (state.active) {
          badge.innerText = `${state.mode} ${remaining}`;
          badge.style.background = state.mode === "BREAK" ? "#2563eb" : "#16a34a";
          badge.style.display = "block";
        } else {
          badge.style.display = "none";
        }
      }
    });
  }

  function format(ms) {
    const s = Math.floor(ms / 1000);
    const m = String(Math.floor(s / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return `${m}:${sec}`;
  }

  function formatLong(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");

    return `${hours}:${minutes}:${seconds}`;
  }

  function showCelebrationOverlay() {
    const existing = document.getElementById("intenta-celebration-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "intenta-celebration-overlay";

    overlay.style = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.85);
      z-index: 1000003;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    overlay.innerHTML = `
      <div style="
        background: #111;
        color: white;
        padding: 32px;
        border-radius: 18px;
        text-align: center;
        max-width: 420px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.4);
      ">
        <div style="font-size: 42px;">🎉</div>
        <h2>Session Complete</h2>
        <p>You showed up. You stayed intentional.</p>
        <button id="closeCelebration">Done</button>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById("closeCelebration").onclick = () => {
      overlay.remove();
    };
  }

  function playSuccessSound() {
    if (!audioUnlocked || !audioCtx) return;

    [660, 880, 990].forEach((freq, index) => {
      setTimeout(() => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.14, audioCtx.currentTime);

        osc.start();
        setTimeout(() => osc.stop(), 140);
      }, index * 140);
    });
  }

  function playCountdownTicks() {
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        playTick();
      }, i * 1000);
    }
  }

  function playTick() {
    if (!audioUnlocked || !audioCtx) return;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type = "sine";
    osc.frequency.value = 1100;

    gain.gain.setValueAtTime(0.18, audioCtx.currentTime);

    osc.start();
    setTimeout(() => osc.stop(), 90);
  }
})();
