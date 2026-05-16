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

    @keyframes intentaOverlayFadeIn {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
  `;
  shadow.appendChild(style);

  let sessionStateInterval = null;
  let audioCtx = null;
  let audioUnlocked = false;
  let lastUrl = location.href;
  let lastYouTubeIntervention = 0;

  function detectYouTubePageType() {
    if (!location.hostname.includes("youtube.com")) {
      return null;
    }

    const url = location.href;

    if (url.includes("/shorts/")) {
      return "SHORTS";
    }

    if (url.includes("/results?search_query=")) {
      return "SEARCH_RESULTS";
    }

    if (url.includes("/watch?v=")) {
      return "WATCH_PAGE";
    }

    if (url.includes("/feed/subscriptions")) {
      return "SUBSCRIPTIONS";
    }

    if (
      location.pathname === "/" ||
      location.pathname === ""
    ) {
      return "HOME_FEED";
    }

    return "OTHER";
  }

  const ytType = detectYouTubePageType();

  if (ytType) {
    console.log("Intenta YouTube Type:", ytType);
  }

  maybeShowYouTubeIntervention();

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      removeYouTubeInterventionOverlay();

      const ytType = detectYouTubePageType();

      console.log("YouTube changed:", ytType);
      maybeShowYouTubeIntervention();
    }
  }, 1000);

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

  function sendMessageWithFallback(message, timeoutMs = 250) {
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(resolveOnce, timeoutMs);

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

  function maybeShowYouTubeIntervention() {
    const ytType = detectYouTubePageType();

    if (ytType !== "HOME_FEED" && ytType !== "SHORTS") {
      return;
    }

    if (Date.now() - lastYouTubeIntervention <= 30000) {
      return;
    }

    safeSendMessage({ type: "GET_SESSION_STATE" }, (state) => {
      if (!state?.active || state.mode !== "FOCUS") return;
      if (Date.now() - lastYouTubeIntervention <= 30000) return;
      if (shadow.getElementById("intenta-block-overlay")) return;

      showYouTubeInterventionOverlay(ytType);
    });
  }

  function showYouTubeInterventionOverlay(type) {
    if (
      shadow.getElementById("intenta-youtube-overlay") ||
      document.getElementById("intenta-youtube-overlay")
    ) {
      return;
    }

    lastYouTubeIntervention = Date.now();

    const overlay = document.createElement("div");
    overlay.id = "intenta-youtube-overlay";

    overlay.style = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.72);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: intentaOverlayFadeIn 180ms ease-out;
    `;

    const isShorts = type === "SHORTS";

    overlay.innerHTML = `
      <div style="
        width: calc(100% - 32px);
        max-width: 380px;
        background: #111;
        color: white;
        padding: 24px;
        border-radius: 14px;
        text-align: center;
        line-height: 1.4;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.4);
      ">
        <p style="font-size:20px;font-weight:700;">
          ${isShorts ? "Shorts can easily become unconscious scrolling." : "What are you here for?"}
        </p>
        ${isShorts ? `
          <button id="ytContinue">Continue Anyway</button>
          <button id="ytLeave">Leave</button>
        ` : `
          <button id="ytSearch">Search Something</button>
          <button id="ytContinue">Continue Intentionally</button>
          <button id="ytLeave">Leave</button>
        `}
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    const searchButton = shadow.getElementById("ytSearch");
    const continueButton = shadow.getElementById("ytContinue");
    const leaveButton = shadow.getElementById("ytLeave");

    if (searchButton) {
      searchButton.addEventListener("click", () => {
        focusYouTubeSearchInput();
        overlay.remove();
      });
    }

    continueButton.addEventListener("click", () => {
      overlay.remove();
    });

    leaveButton.addEventListener("click", () => {
      overlay.remove();
      window.history.back();
    });
  }

  function focusYouTubeSearchInput() {
    const searchInput = document.querySelector(
      "input#search, input[name='search_query'], ytd-searchbox input"
    );

    if (!searchInput) return;

    searchInput.focus();
    if (searchInput.select) searchInput.select();
  }

  function removeYouTubeInterventionOverlay() {
    const overlay = shadow.getElementById("intenta-youtube-overlay");
    if (overlay) overlay.remove();
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

    if (message.type === "REALTIME_BLOCK") {
      showBlockedOverlay();
    }

    if (message.type === "CLEAR_OVERLAYS") {
      clearIntentaOverlays();
    }

    if (message.type === "SESSION_COMPLETE") {
      clearIntentaOverlays();
      showCelebrationOverlay(message.summary);
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

    removeYouTubeInterventionOverlay();

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
        <button id="add">Add to Focus</button>
        <button id="back">Go Back</button>
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
        safeSendMessage({ type: "DISTRACTION_CLOSED" });
        overlay.remove();
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
      <button id="historyBtn">Session History</button>
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

    withButtonFeedback(
      shadow.getElementById("historyBtn"),
      async () => {
        const response = await sendMessageWithFallback({ type: "GET_SESSION_HISTORY" }, 1000);
        showHistoryModal(response?.history || []);
      },
      ""
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
    const history = shadow.getElementById("historyBtn");

    if (start) start.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (stop) stop.style.cssText = `${buttonBaseStyle} background: #ef4444; color: white;`;
    if (tabs) tabs.style.cssText = `${buttonBaseStyle} background: #222; color: white;`;
    if (history) history.style.cssText = `${buttonBaseStyle} background: #222; color: white;`;
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
    const closeHistory = container.querySelector("#closeHistory");
    const clearHistory = container.querySelector("#clearHistoryBtn");
    const ytSearch = container.querySelector("#ytSearch");
    const ytContinue = container.querySelector("#ytContinue");
    const ytLeave = container.querySelector("#ytLeave");

    if (add) add.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (back) back.style.cssText = `${buttonBaseStyle} background: #222; color: white;`;
    if (closeCelebration) closeCelebration.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (closeHistory) closeHistory.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (clearHistory) clearHistory.style.cssText = `${buttonBaseStyle} background: #ef4444; color: white;`;
    if (ytSearch) ytSearch.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (ytContinue) ytContinue.style.cssText = `${buttonBaseStyle} background: #222; color: white;`;
    if (ytLeave) ytLeave.style.cssText = `${buttonBaseStyle} background: #ef4444; color: white;`;
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
      const history = shadow.getElementById("historyBtn");
      const badge = shadow.getElementById("intenta-timer-badge");
      const isActive = Boolean(state && state.active);
      const isFocus = isActive && state.mode === "FOCUS";
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
      if (isFocus) {
        maybeShowYouTubeIntervention();
      } else {
        removeYouTubeInterventionOverlay();
      }

      if (config) config.style.display = isActive ? "none" : "flex";
      if (start) start.style.display = isActive ? "none" : "block";
      if (stop) stop.style.display = isActive ? "block" : "none";
      if (tabs) tabs.style.display = isFocus ? "block" : "none";
      if (history) history.style.display = isActive ? "none" : "block";

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

  function clearIntentaOverlays() {
    console.log("Clearing overlays");

    const selectors = [
      "#intenta-block-overlay",
      "#intenta-youtube-overlay",
      "#intenta-celebration-overlay",
      "#intenta-history-modal",
      "#intenta-panel",
      "#intenta-toast"
    ];

    selectors.forEach((selector) => {
      const el =
        shadow.querySelector(selector) ||
        document.querySelector(selector);

      console.log("Removing:", selector, el);

      if (el) {
        console.log("Removing", selector);
        el.remove();
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

  function showHistoryModal(history) {
    const existing = shadow.getElementById("intenta-history-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "intenta-history-modal";

    overlay.style = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.75);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    `;

    const listHtml = history.length
      ? history.map((item) => `
          <div style="
            background: #181818;
            border: 1px solid #333;
            border-radius: 10px;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 6px;
          ">
            <div style="font-weight:700;">${item.cyclesCompleted || 0}/${item.totalCycles || 0} cycles • ${item.focusTimeFormatted || `${item.focusMinutes || 0} min`} focus</div>
            <div style="font-size:12px;opacity:0.75;">Closed: ${item.distractionsClosed || 0} • Added: ${item.sitesAdded || 0}</div>
            <div style="font-size:12px;opacity:0.6;">${formatHistoryDate(item.completedAt)}</div>
          </div>
        `).join("")
      : `<div style="font-size:13px;opacity:0.75;text-align:center;">No sessions yet</div>`;

    overlay.innerHTML = `
      <div style="
        width: calc(100% - 32px);
        max-width: 420px;
        max-height: 80vh;
        overflow: auto;
        background: #111;
        color: white;
        padding: 20px;
        border-radius: 16px;
        line-height: 1.4;
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.4);
      ">
        <h2 style="font-size:18px;">Session History</h2>
        <div style="display:flex;flex-direction:column;gap:10px;">${listHtml}</div>
        ${history.length ? `<button id="clearHistoryBtn">Clear History</button>` : ""}
        <button id="closeHistory">Close</button>
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    shadow.getElementById("closeHistory").addEventListener("click", () => {
      overlay.remove();
    });

    const clearHistoryBtn = shadow.getElementById("clearHistoryBtn");

    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener("click", () => {
        if (!confirm("Clear all session history?")) return;

        safeSendMessage({ type: "CLEAR_SESSION_HISTORY" }, () => {
          showHistoryModal([]);
        });
      });
    }
  }

  function formatHistoryDate(value) {
    if (!value) return "Unknown time";

    return new Date(value).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function showCelebrationOverlay(summary = {}) {
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
        <div style="
          width: 100%;
          background: #181818;
          border: 1px solid #333;
          border-radius: 12px;
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          text-align: left;
          font-size: 14px;
        ">
          <div><strong>Cycles:</strong> ${summary.cyclesCompleted || 0}/${summary.totalCycles || 0}</div>
          <div><strong>Focus time:</strong> ${summary.focusTimeFormatted || `${summary.focusMinutes || 0} min`}</div>
          <div><strong>Break time:</strong> ${summary.breakTimeFormatted || `${summary.breakMinutes || 0} min`}</div>
          <div><strong>Distractions closed:</strong> ${summary.distractionsClosed || 0}</div>
          <div><strong>Sites added to focus:</strong> ${summary.sitesAdded || 0}</div>
        </div>
        <button id="closeCelebration">Done</button>
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    const doneBtn = shadow.getElementById("closeCelebration");
    doneBtn.addEventListener("click", () => {
      safeSendMessage({ type: "CLEAR_ALL_OVERLAYS" });
    });
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
