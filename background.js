console.log("Intenta background running");

let session = {
  active: false,
  mode: "IDLE",
  startTime: null,
  duration: 0,
  focusDuration: 0,
  breakDuration: 0,
  currentCycle: 0,
  totalCycles: 0,
  warned5: false,
  distractionsClosed: 0,
  sitesAdded: 0,
  addedDomains: new Set()
};

const DEFAULT_FOCUS_MINUTES = 50;
const DEFAULT_BREAK_MINUTES = 10;
const DEFAULT_CYCLES = 3;

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

    session.active = true;
    session.mode = "FOCUS";
    session.startTime = Date.now();
    session.focusDuration = focusMinutes * 60 * 1000;
    session.breakDuration = breakMinutes * 60 * 1000;
    session.totalCycles = Math.floor(cycles);
    session.currentCycle = 1;
    session.duration = session.focusDuration;
    session.warned5 = false;
    session.distractionsClosed = 0;
    session.sitesAdded = 0;
    session.addedDomains = new Set();

    console.log("Focus session started");
  }

  // 🔹 STOP SESSION
  else if (message.type === "STOP_SESSION") {
    session.active = false;
    session.mode = "IDLE";
    session.startTime = null;
    session.duration = 0;
    session.focusDuration = 0;
    session.breakDuration = 0;
    session.currentCycle = 0;
    session.totalCycles = 0;
    session.warned5 = false;
    session.distractionsClosed = 0;
    session.sitesAdded = 0;
    session.addedDomains = new Set();

    chrome.storage.local.remove(["allowedSites"], () => {
      console.log("Session cleared");
    });

    console.log("Session stopped");
  }

  // 🔹 PAGE DATA (CORE LOGIC)
  else if (message.type === "PAGE_DATA") {
    const { url } = message.data;
    const domain = normalizeDomain(new URL(url).hostname);
    syncSessionState();

    if (!session.active) {
      sendResponse({ action: "ALLOW" });
      return;
    }

    if (session.mode === "BREAK") {
      sendResponse({ action: "ALLOW" });
      return;
    }

    // Allow Google search results
    if (url.includes("google.com/search")) {
      sendResponse({ action: "ALLOW" });
      return;
    }

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
      remaining,
      totalRemaining,
      currentCycle: session.currentCycle,
      totalCycles: session.totalCycles,
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
          if (!tab.url || isUnsupportedUrl(tab.url) || tab.url.includes("google.com/search")) {
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

  if (url.includes("google.com/search")) {
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

function syncSessionState() {
  if (!session.active || !session.startTime || !session.duration) {
    return;
  }

  const remaining = getRemainingTime();

  if (remaining <= 5000 && !session.warned5) {
    session.warned5 = true;
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
    evaluateAllTabs();
  }
}

function stopSessionState() {
  session.active = false;
  session.mode = "IDLE";
  session.startTime = null;
  session.duration = 0;
  session.focusDuration = 0;
  session.breakDuration = 0;
  session.currentCycle = 0;
  session.totalCycles = 0;
  session.warned5 = false;
  session.distractionsClosed = 0;
  session.sitesAdded = 0;
  session.addedDomains = new Set();
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
    completedAt: Date.now(),
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
  chrome.storage.local.get(["sessionHistory"], (result) => {
    const existing = result.sessionHistory || [];
    const updated = [summary, ...existing].slice(0, 20);

    chrome.storage.local.set({
      sessionHistory: updated
    });
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

function getRemainingTime() {
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

  if (session.mode === "FOCUS") {
    return currentRemaining + session.breakDuration + (remainingFullCycles * focusBreakDuration);
  }

  return currentRemaining + (remainingFullCycles * focusBreakDuration);
}
