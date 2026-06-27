console.log("Intenta background running");

let session = {
  active: false,
  mode: "IDLE",
  paused: false,
  pausedAt: null,
  remainingAtPause: 0,
  previousModeBeforePause: null,
  startTime: null,
  sessionStartTime: null,
  duration: 0,
  focusDuration: 0,
  breakDuration: 0,
  currentCycle: 0,
  totalCycles: 0,
  focusGoal: "",
  warned5: false,
  distractionsClosed: 0,
  sitesAdded: 0,
  addedDomains: new Set()
};

const DEFAULT_FOCUS_MINUTES = 50;
const DEFAULT_BREAK_MINUTES = 10;
const DEFAULT_CYCLES = 3;
const SESSION_STATE_KEY = "sessionState";

chrome.storage.local.get([SESSION_STATE_KEY], (result) => {
  if (result.sessionState) {
    restoreSessionState(result.sessionState);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // 🔹 START SESSION
  if (message.type === "START_SESSION") {
    const focusMinutes =
      Number.isFinite(message.data?.focus) && message.data.focus > 0
        ? message.data.focus
        : DEFAULT_FOCUS_MINUTES;
    const breakMinutes =
      Number.isFinite(message.data?.break) && message.data.break > 0
        ? message.data.break
        : DEFAULT_BREAK_MINUTES;
    const cycles =
      Number.isFinite(message.data?.cycles) && message.data.cycles > 0
        ? message.data.cycles
        : DEFAULT_CYCLES;
    const focusGoal = message.data?.focusGoal?.trim() || "Focus Session";

    session.active = true;
    session.mode = "FOCUS";
    session.paused = false;
    session.pausedAt = null;
    session.remainingAtPause = 0;
    session.previousModeBeforePause = null;
    session.startTime = Date.now();
    session.sessionStartTime = Date.now();
    session.focusDuration = focusMinutes * 60 * 1000;
    session.breakDuration = breakMinutes * 60 * 1000;
    session.totalCycles = Math.floor(cycles);
    session.currentCycle = 1;
    session.focusGoal = focusGoal;
    session.duration = session.focusDuration;
    session.warned5 = false;
    session.distractionsClosed = 0;
    session.sitesAdded = 0;
    session.addedDomains = new Set();
    persistSessionState();

    console.log("Focus session started");
  }

  // 🔹 STOP SESSION
  else if (message.type === "STOP_SESSION") {
    saveStoppedSession();
    stopSessionState();

    chrome.storage.local.remove(["allowedSites"], () => {
      console.log("Session cleared");
    });

    console.log("Session stopped");
  }

  // 🔹 PAUSE SESSION
  else if (message.type === "PAUSE_SESSION") {
    if (session.active && !session.paused) {
      const remainingAtPause = getRemainingTime();

      session.paused = true;
      session.pausedAt = Date.now();
      session.remainingAtPause = remainingAtPause;
      session.previousModeBeforePause = session.mode;
      session.mode = "PAUSED";
      persistSessionState();
    }
  }

  // 🔹 RESUME SESSION
  else if (message.type === "RESUME_SESSION") {
    if (session.active && session.paused) {
      session.paused = false;
      session.mode = session.previousModeBeforePause || "FOCUS";
      session.startTime = Date.now();
      session.duration = session.remainingAtPause;
      session.pausedAt = null;
      session.remainingAtPause = 0;
      session.previousModeBeforePause = null;
      session.warned5 = false;
      persistSessionState();

      if (session.mode === "FOCUS") {
        evaluateAllTabs();
      }
    }
  }

  // 🔹 PAGE DATA (CORE LOGIC)
  else if (message.type === "PAGE_DATA") {
    const { url } = message.data;
    syncSessionState();

    if (!session.active) {
      sendResponse({ action: "ALLOW" });
      return;
    }

    if (session.paused || session.mode !== "FOCUS") {
      sendResponse({ action: "ALLOW" });
      return;
    }

    if (isAllowedGoogleRedirect(url)) {
      sendResponse({ action: "ALLOW" });
      return;
    }

    const domain = normalizeDomain(new URL(url).hostname);

    chrome.storage.local.get(["allowedSites"], (result) => {
      const allowedSites = result.allowedSites || [];

      const isAllowed = isDomainAllowed(domain, allowedSites);

      if (!isAllowed) {
        sendResponse({ action: "BLOCK" });
      } else {
        sendResponse({ action: "ALLOW" });
      }
    });

    return true;
  }

  // 🔹 GET SESSION STATE
  else if (message.type === "GET_SESSION_STATE") {
    syncSessionState();
    const remaining = getRemainingTime();
    const totalRemaining = getTotalRemainingTime(remaining);

    sendResponse({
      active: session.active,
      mode: session.mode,
      paused: session.paused,
      previousModeBeforePause: session.previousModeBeforePause,
      remaining,
      totalRemaining,
      currentCycle: session.currentCycle,
      totalCycles: session.totalCycles,
      focusGoal: session.focusGoal || "",
      focusMinutes: session.focusDuration / 60 / 1000,
      breakMinutes: session.breakDuration / 60 / 1000
    });
  }

  // 🔹 SET ALLOWED SITES
  else if (message.type === "SET_ALLOWED_SITES") {
    const domains = message.data.domains;
    const uniqueDomains = [...new Set(domains)];

    chrome.storage.local.set({ allowedSites: uniqueDomains });
  }

  // 🔹 ADD DOMAIN
  else if (message.type === "ADD_TO_ALLOWED_SITES") {
    const domain = normalizeDomain(message.data.domain);

    chrome.storage.local.get(["allowedSites"], (result) => {
      const existing = result.allowedSites || [];
      const updated = [...new Set([...existing, domain])];
      const isAlreadyAllowed = isDomainAllowed(domain, existing);

      chrome.storage.local.set({ allowedSites: updated }, () => {
        if (!isAlreadyAllowed) {
          trackAddedDomain(domain);
        }
        persistSessionState();
        sendResponse({ success: true });
      });
    });

    return true;
  }

  // 🔹 GET TABS
  else if (message.type === "GET_TABS") {
    chrome.tabs.query({}, (tabs) => {
      const domains = tabs.map(tab => {
        try {
          if (!tab.url || isUnsupportedUrl(tab.url) || isAllowedGoogleRedirect(tab.url)) {
            return null;
          }

          return normalizeDomain(new URL(tab.url).hostname);
        } catch {
          return null;
        }
      }).filter(Boolean);

      const uniqueDomains = [...new Set(domains)];

      chrome.storage.local.get(["allowedSites"], (result) => {
        const existing = result.allowedSites || [];
        const newlyAddedDomains = uniqueDomains.filter(domain =>
          !isDomainAllowed(domain, existing)
        );
        const updated = [...new Set([...existing, ...uniqueDomains])];

        chrome.storage.local.set({ allowedSites: updated }, () => {
          newlyAddedDomains.forEach(trackAddedDomain);
          persistSessionState();
        });
      });
    });
  }

  // 🔹 GET SESSION HISTORY
  else if (message.type === "GET_SESSION_HISTORY") {
    chrome.storage.local.get(["sessionHistory"], (result) => {
      sendResponse({
        history: result.sessionHistory || []
      });
    });

    return true;
  }

  // 🔹 CLEAR SESSION HISTORY
  else if (message.type === "CLEAR_SESSION_HISTORY") {
    chrome.storage.local.set({
      sessionHistory: []
    }, () => {
      sendResponse({ success: true });
    });

    return true;
  }

  // 🔹 USER CLOSED A DISTRACTION
  else if (message.type === "DISTRACTION_CLOSED") {
    session.distractionsClosed = (session.distractionsClosed || 0) + 1;
    persistSessionState();
  }

  // 🔹 AI INTENT ALIGNMENT (proxy through local backend)
  else if (message.type === "AI_CLASSIFY_INTENT") {
    if (!shouldRunIntelligence()) {
      sendResponse({
        alignment: "UNCLEAR",
        confidence: 0,
        reason: "Intelligence is disabled outside active focus sessions."
      });
      return true;
    }

    classifyIntentWithBackend(message.data)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          alignment: "UNCLEAR",
          confidence: 0,
          reason: error?.message || "AI backend unavailable"
        });
      });

    return true;
  }

  // 🔹 CLEAR OVERLAYS IN ALL TABS
  else if (message.type === "CLEAR_ALL_OVERLAYS") {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        safeSendToTab(tab.id, {
          type: "CLEAR_OVERLAYS"
        });
      });
    });
  }

});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    evaluateTab(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    evaluateTab(activeInfo.tabId, tab.url);
  });
});

function evaluateTab(tabId, url, shouldSync = true) {
  if (shouldSync) {
    syncSessionState();
  }

  if (!session.active || session.mode !== "FOCUS") {
    return;
  }

  if (!url || isUnsupportedUrl(url)) {
    return;
  }

  if (isAllowedGoogleRedirect(url)) {
    return;
  }

  let domain;

  try {
    domain = normalizeDomain(new URL(url).hostname);
  } catch {
    return;
  }

  chrome.storage.local.get(["allowedSites"], (result) => {
    const allowedSites = result.allowedSites || [];
    const isAllowed = isDomainAllowed(domain, allowedSites);

    if (!isAllowed) {
      safeSendToTab(tabId, { type: "REALTIME_BLOCK" });
    }
  });
}

function evaluateAllTabs() {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      evaluateTab(tab.id, tab.url, false);
    });
  });
}

function isUnsupportedUrl(url) {
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:")
  );
}

function isAllowedGoogleRedirect(url) {
  try {
    const parsed = new URL(url);

    return (
      parsed.origin === "https://www.google.com" &&
      (
        parsed.pathname === "/" ||
        parsed.pathname === "/webhp" ||
        parsed.pathname === "/search"
      )
    );
  } catch {
    return false;
  }
}

function syncSessionState() {
  if (session.paused || session.mode === "PAUSED") {
    return;
  }

  if (!session.active || !session.startTime || !session.duration) {
    return;
  }

  const remaining = getRemainingTime();

  if (remaining <= 5000 && !session.warned5) {
    session.warned5 = true;
    persistSessionState();
    broadcast({
      type: "COUNTDOWN_START",
      mode: session.mode
    });
  }

  if (remaining > 0) {
    return;
  }

  session.startTime = Date.now();
  session.warned5 = false;

  if (session.mode === "FOCUS") {
    session.mode = "BREAK";
    session.duration = session.breakDuration;
    persistSessionState();
  } else if (session.mode === "BREAK") {
    if (session.currentCycle >= session.totalCycles) {
      const summary = buildSessionSummary();
      saveSessionHistory(summary);
      broadcast({
        type: "SESSION_COMPLETE",
        summary
      });
      stopSessionState();
      chrome.storage.local.remove(["allowedSites"]);
      return;
    }

    session.currentCycle++;
    session.mode = "FOCUS";
    session.duration = session.focusDuration;
    persistSessionState();
    evaluateAllTabs();
  }
}

function stopSessionState() {
  session.active = false;
  session.mode = "IDLE";
  session.paused = false;
  session.pausedAt = null;
  session.remainingAtPause = 0;
  session.previousModeBeforePause = null;
  session.startTime = null;
  session.sessionStartTime = null;
  session.duration = 0;
  session.focusDuration = 0;
  session.breakDuration = 0;
  session.currentCycle = 0;
  session.totalCycles = 0;
  session.focusGoal = "";
  session.warned5 = false;
  session.distractionsClosed = 0;
  session.sitesAdded = 0;
  session.addedDomains = new Set();
  persistSessionState();
}

function trackAddedDomain(domain) {
  if (!domain || session.addedDomains.has(domain)) {
    return;
  }

  session.addedDomains.add(domain);
  session.sitesAdded++;
}

function normalizeDomain(domain) {
  return (domain || "").replace(/^www\./, "");
}

function isDomainAllowed(domain, allowedSites) {
  return allowedSites.some(site => domain.includes(normalizeDomain(site)));
}

function formatDuration(minutesFloat) {
  if (minutesFloat < 1) {
    return `${Math.round(minutesFloat * 60)} sec`;
  }

  if (minutesFloat % 1 === 0) {
    return `${minutesFloat} min`;
  }

  return `${minutesFloat.toFixed(1)} min`;
}

function buildSessionSummary() {
  const focusMinutes =
    ((session.focusDuration || 0) *
      (session.totalCycles || 0)) / 60000;

  const breakMinutes =
    ((session.breakDuration || 0) *
      Math.max((session.totalCycles || 0) - 1, 0)) / 60000;

  return {
    id: Date.now(),
    status: "COMPLETED",
    completedAt: Date.now(),
    focusGoal: session.focusGoal || "",
    cyclesCompleted: session.totalCycles || session.currentCycle || 0,
    totalCycles: session.totalCycles || 0,
    focusMinutes,
    breakMinutes,
    focusTimeFormatted: formatDuration(focusMinutes),
    breakTimeFormatted: formatDuration(breakMinutes),
    distractionsClosed: session.distractionsClosed || 0,
    sitesAdded: session.sitesAdded || 0
  };
}

function saveSessionHistory(summary) {
  addToSessionHistory(summary);
}

function addToSessionHistory(historyItem) {
  chrome.storage.local.get(["sessionHistory"], (result) => {
    const existing = result.sessionHistory || [];
    const updated = [historyItem, ...existing].slice(0, 20);

    chrome.storage.local.set({
      sessionHistory: updated
    });
  });
}

function saveStoppedSession() {
  if (!session.active || !session.sessionStartTime) {
    return;
  }

  const elapsedMinutes =
    (Date.now() - session.sessionStartTime) / (1000 * 60);

  if (elapsedMinutes < 5) {
    return;
  }

  const historyItem = {
    id: Date.now(),
    status: "STOPPED_EARLY",
    completedAt: new Date().toISOString(),
    focusGoal: session.focusGoal,
    completedCycles: Math.max((session.currentCycle || 0) - 1, 0),
    totalCycles: session.totalCycles,
    focusMinutesSpent: Math.round(elapsedMinutes),
    sitesAdded: session.sitesAdded || 0,
    distractionsClosed: session.distractionsClosed || 0
  };

  addToSessionHistory(historyItem);
}

function serializeSessionState() {
  return {
    ...session,
    addedDomains: [...session.addedDomains]
  };
}

function restoreSessionState(savedSession) {
  session = {
    ...session,
    ...savedSession,
    focusGoal: savedSession.focusGoal || "",
    addedDomains: new Set(savedSession.addedDomains || [])
  };
}

function persistSessionState() {
  chrome.storage.local.set({
    [SESSION_STATE_KEY]: serializeSessionState()
  });
}

function broadcast(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      safeSendToTab(tab.id, message);
    });
  });
}

function safeSendToTab(tabId, message) {
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        return;
      }
    });
  } catch {}
}

function shouldRunIntelligence() {
  return (
    session &&
    session.active === true &&
    session.paused !== true &&
    session.mode === "FOCUS"
  );
}

async function classifyIntentWithBackend(data = {}) {
  if (!shouldRunIntelligence()) {
    return {
      alignment: "UNCLEAR",
      confidence: 0,
      reason: "Intelligence is disabled outside active focus sessions."
    };
  }

  const response = await fetch("http://localhost:3001/classify-intent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      focusGoal: data.focusGoal || session.focusGoal || "Focus Session",
      pageType: data.pageType || "UNKNOWN",
      title: data.title || "",
      url: data.url || "",
      domain: data.domain || ""
    })
  });

  if (!response.ok) {
    throw new Error(`AI backend returned ${response.status}`);
  }

  return response.json();
}

function getRemainingTime() {
  if (session.paused || session.mode === "PAUSED") {
    return session.remainingAtPause || 0;
  }

  if (!session.active || !session.startTime) {
    return 0;
  }

  return Math.max(session.duration - (Date.now() - session.startTime), 0);
}

function getTotalRemainingTime(currentRemaining) {
  if (!session.active) {
    return 0;
  }

  const focusBreakDuration = session.focusDuration + session.breakDuration;
  const remainingFullCycles = Math.max(session.totalCycles - session.currentCycle, 0);

  const effectiveMode = session.mode === "PAUSED"
    ? session.previousModeBeforePause
    : session.mode;

  if (effectiveMode === "FOCUS") {
    return currentRemaining + session.breakDuration + (remainingFullCycles * focusBreakDuration);
  }

  return currentRemaining + (remainingFullCycles * focusBreakDuration);
}
