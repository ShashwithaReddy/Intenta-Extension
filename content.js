(function () {
  console.log("Intenta content loaded");

  const hostId = "intenta-shadow-host";
  if (document.getElementById(hostId)) return;

  const host = document.createElement("div");
  host.id = hostId;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host, * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      font-family: Inter, system-ui, sans-serif !important;
    }

    button,
    input {
      font: inherit;
      border: none;
      outline: none;
      appearance: none;
    }

    button {
      transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
    }

    button:active {
      transform: scale(0.96);
    }

    @keyframes intentaToastIn {
      from {
        opacity: 0;
        transform: translateY(8px) scale(0.96);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
  `;
  shadow.appendChild(style);

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

  function sendMessageWithFallback(message) {
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(resolveOnce, 250);

      function resolveOnce(response) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(response);
      }

      safeSendMessage(message, resolveOnce);
    });
  }

  function withButtonFeedback(button, action, successText = "Done") {
    button.addEventListener("click", async () => {
      button.style.transform = "scale(0.96)";
      button.style.opacity = "0.75";
      button.disabled = true;

      setTimeout(() => {
        button.style.transform = "scale(1)";
      }, 120);

      try {
        await action();
        if (successText) showToast(successText);
      } finally {
        setTimeout(() => {
          button.disabled = false;
          button.style.opacity = "1";
        }, 400);
      }
    });
  }

  function showToast(message) {
    const existing = shadow.getElementById("intenta-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "intenta-toast";
    toast.textContent = message;

    toast.style.cssText = `
      position: fixed;
      bottom: 150px;
      right: 20px;
      background: #111;
      color: white;
      padding: 10px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      z-index: 2147483647;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      animation: intentaToastIn 180ms ease-out;
    `;

    shadow.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 1600);
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
      renderSessionState();
      stopSessionStateUpdates();
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
    safeSendMessage({ type: "GET_SESSION_STATE" }, (state) => {
      if (!state?.active || state.mode !== "FOCUS") return;
      renderBlockedOverlay();
    });
  }

  function renderBlockedOverlay() {
    const existing = shadow.getElementById("intenta-block-overlay");
    if (existing) return;

    const overlay = document.createElement("div");
    overlay.id = "intenta-block-overlay";

    overlay.style = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.8);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    overlay.innerHTML = `
      <div style="
        width: calc(100% - 32px);
        max-width: 360px;
        background: #111;
        color: white;
        padding: 24px;
        border-radius: 10px;
        text-align: center;
        line-height: 1.4;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
      ">
        <p style="font-size:20px;font-weight:700;">This site is not part of your focus session.</p>
        <button id="add">Add to session</button>
        <button id="back">Go back</button>
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    withButtonFeedback(
      shadow.getElementById("add"),
      async () => {
        await sendMessageWithFallback({
          type: "ADD_TO_ALLOWED_SITES",
          data: { domain: window.location.hostname }
        });
        overlay.remove();
        setTimeout(() => {
          window.location.reload();
        }, 500);
      },
      "Site added to focus"
    );

    withButtonFeedback(
      shadow.getElementById("back"),
      () => {
        window.history.back();
      },
      ""
    );
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

    shadow.appendChild(widget);

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

    shadow.appendChild(badge);

    widget.onclick = togglePanel;
    startSessionStateUpdates();
  }

  function togglePanel() {
    let panel = shadow.getElementById("intenta-panel");

    if (panel) {
      panel.remove();
      return;
    }

    panel = document.createElement("div");
    panel.id = "intenta-panel";

    panel.style.cssText = `
      position: fixed;
      bottom: 80px;
      right: 20px;
      width: 260px;
      background: #111;
      color: white;
      padding: 16px;
      border-radius: 12px;
      z-index: 999999;
      font-family: system-ui;
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;

    panel.innerHTML = `
      <div id="sessionStatus">
        <div id="cycleText" style="font-weight: 600;">Cycle: -- / --</div>
        <div id="modeText" style="font-weight: 600;">Mode: IDLE</div>
        <div id="timeText" style="font-weight: 600;">Remaining: --:--</div>
        <div id="totalText" style="font-size: 12px; opacity: 0.7;">Total left: --:--:--</div>
      </div>
      <div id="session-config" style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
        <input id="cycles" placeholder="Cycles" />
        <input id="focusTime" placeholder="Focus (min)" />
        <input id="breakTime" placeholder="Break (min)" />
        <button id="start">Start Session</button>
      </div>
      <div style="margin-top:10px; border-top:1px solid #333;"></div>
      <button id="stop">Stop</button>
      <button id="tabs">Use Tabs</button>
    `;

    shadow.appendChild(panel);
    stylePanelControls(panel);

    withButtonFeedback(shadow.getElementById("start"), async () => {
      const cycles = Number(shadow.getElementById("cycles").value);
      const focus = Number(shadow.getElementById("focusTime").value);
      const breakTime = Number(shadow.getElementById("breakTime").value);

      await sendMessageWithFallback({
        type: "START_SESSION",
        data: {
          focus,
          break: breakTime,
          cycles
        }
      });

      renderSessionState();
      startSessionStateUpdates();
    }, "Session started");

    withButtonFeedback(shadow.getElementById("stop"), async () => {
      await sendMessageWithFallback({ type: "STOP_SESSION" });
      renderSessionState();
      stopSessionStateUpdates();
    }, "Session stopped");

    withButtonFeedback(
      shadow.getElementById("tabs"),
      () => sendMessageWithFallback({ type: "GET_TABS" }),
      "Open tabs added to focus"
    );

    renderSessionState();
    startSessionStateUpdates();
  }

  function stylePanelControls(panel) {
    const inputStyle = `
      width: 100%;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid #444;
      background: #000;
      color: white;
      box-sizing: border-box;
    `;
    const buttonBaseStyle = `
      width: 100%;
      padding: 10px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      appearance: none;
    `;

    panel.querySelectorAll("input").forEach((input) => {
      input.style.cssText = inputStyle;
    });

    const start = shadow.getElementById("start");
    const stop = shadow.getElementById("stop");
    const tabs = shadow.getElementById("tabs");

    if (start) start.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (stop) stop.style.cssText = `${buttonBaseStyle} background: #ef4444; color: white;`;
    if (tabs) tabs.style.cssText = `${buttonBaseStyle} background: #222; color: white;`;
  }

  function styleOverlayButtons(container) {
    const buttonBaseStyle = `
      width: 100%;
      padding: 10px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      appearance: none;
    `;
    const add = container.querySelector("#add");
    const back = container.querySelector("#back");
    const closeCelebration = container.querySelector("#closeCelebration");

    if (add) add.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (back) back.style.cssText = `${buttonBaseStyle} background: #222; color: white;`;
    if (closeCelebration) closeCelebration.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
  }

  function startSessionStateUpdates() {
    if (sessionStateInterval) return;

    sessionStateInterval = setInterval(renderSessionState, 1000);
  }

  function stopSessionStateUpdates() {
    if (!sessionStateInterval) return;

    clearInterval(sessionStateInterval);
    sessionStateInterval = null;
  }

  function renderSessionState() {
    safeSendMessage({ type: "GET_SESSION_STATE" }, (state) => {
      if (!state) return;

      const cycleText = shadow.getElementById("cycleText");
      const modeText = shadow.getElementById("modeText");
      const timeText = shadow.getElementById("timeText");
      const totalText = shadow.getElementById("totalText");
      const config = shadow.getElementById("session-config");
      const start = shadow.getElementById("start");
      const stop = shadow.getElementById("stop");
      const tabs = shadow.getElementById("tabs");
      const badge = shadow.getElementById("intenta-timer-badge");
      const isActive = Boolean(state && state.active);
      const mode = isActive ? state.mode : "IDLE";
      const remaining = format(state.remaining);
      const totalRemaining = formatLong(state.totalRemaining || 0);

      if (cycleText) {
        cycleText.innerText = isActive
          ? `Cycle: ${state.currentCycle} / ${state.totalCycles}`
          : "Cycle: -- / --";
      }
      if (modeText) modeText.innerText = "Mode: " + mode;
      if (timeText) timeText.innerText = "Remaining: " + remaining;
      if (totalText) totalText.innerText = "Total left: " + totalRemaining;

      if (!isActive || state.mode === "BREAK") removeBlockedOverlay();

      if (config) config.style.display = isActive ? "none" : "flex";
      if (start) start.style.display = isActive ? "none" : "block";
      if (stop) stop.style.display = isActive ? "block" : "none";
      if (tabs) tabs.style.display = isActive ? "block" : "none";

      if (badge) {
        if (isActive) {
          badge.innerText = `${state.mode} ${remaining}`;
          badge.style.background = state.mode === "BREAK" ? "#2563eb" : "#16a34a";
          badge.style.display = "block";
        } else {
          badge.style.display = "none";
        }
      }
    });
  }

  function removeBlockedOverlay() {
    const overlay = shadow.getElementById("intenta-block-overlay");
    if (overlay) overlay.remove();
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
    const existing = shadow.getElementById("intenta-celebration-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "intenta-celebration-overlay";

    overlay.style = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.85);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    overlay.innerHTML = `
      <div style="
        width: calc(100% - 32px);
        background: #111;
        color: white;
        padding: 32px;
        border-radius: 18px;
        text-align: center;
        max-width: 420px;
        line-height: 1.4;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.4);
      ">
        <div style="font-size: 42px;">🎉</div>
        <h2>Session Complete</h2>
        <p>You showed up. You stayed intentional.</p>
        <button id="closeCelebration">Done</button>
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    withButtonFeedback(
      shadow.getElementById("closeCelebration"),
      () => {
        overlay.remove();
      },
      ""
    );
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
