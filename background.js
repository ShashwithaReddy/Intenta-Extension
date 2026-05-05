console.log("Intenta background running");

let session = {
  active: false,
  mode: "IDLE",
  startTime: null,
  duration: 0,
  totalStartTime: null,
  totalDuration: 0,
  focusDuration: 0,
  breakDuration: 0,
  warned5: false
};

const DEFAULT_TOTAL_MINUTES = 180;
const DEFAULT_FOCUS_MINUTES = 50;
const DEFAULT_BREAK_MINUTES = 10;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // 🔹 START SESSION
  if (message.type === "START_SESSION") {
    const totalMinutes =
      Number.isFinite(message.data?.total) && message.data.total > 0
        ? message.data.total
        : DEFAULT_TOTAL_MINUTES;
    const focusMinutes =
      Number.isFinite(message.data?.focus) && message.data.focus > 0
        ? message.data.focus
        : DEFAULT_FOCUS_MINUTES;
    const breakMinutes =
      Number.isFinite(message.data?.break) && message.data.break > 0
        ? message.data.break
        : DEFAULT_BREAK_MINUTES;

    session.active = true;
    session.mode = "FOCUS";
    session.startTime = Date.now();
    session.totalStartTime = session.startTime;
    session.totalDuration = totalMinutes * 60 * 1000;
    session.focusDuration = focusMinutes * 60 * 1000;
    session.breakDuration = breakMinutes * 60 * 1000;
    session.duration = session.focusDuration;
    session.warned5 = false;

    console.log("Focus session started");
  }

  // 🔹 STOP SESSION
  else if (message.type === "STOP_SESSION") {
    session.active = false;
    session.mode = "IDLE";
    session.startTime = null;
    session.duration = 0;
    session.totalStartTime = null;
    session.totalDuration = 0;
    session.focusDuration = 0;
    session.breakDuration = 0;
    session.warned5 = false;

    chrome.storage.local.remove(["allowedSites"], () => {
      console.log("Session cleared");
    });

    console.log("Session stopped");
  }

  // 🔹 PAGE DATA (CORE LOGIC)
  else if (message.type === "PAGE_DATA") {
    const { url } = message.data;
    const domain = new URL(url).hostname;
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

      const isAllowed = allowedSites.some(site =>
        domain.includes(site)
      );

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
    const totalRemaining = getTotalRemainingTime();

    sendResponse({
      active: session.active,
      mode: session.mode,
      remaining,
      totalRemaining,
      totalDuration: session.totalDuration,
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
    const { domain } = message.data;

    chrome.storage.local.get(["allowedSites"], (result) => {
      const existing = result.allowedSites || [];
      const updated = [...new Set([...existing, domain])];

      chrome.storage.local.set({ allowedSites: updated }, () => {
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
          return new URL(tab.url).hostname;
        } catch {
          return null;
        }
      }).filter(Boolean);

      const uniqueDomains = [...new Set(domains)];

      chrome.storage.local.get(["allowedSites"], (result) => {
        const existing = result.allowedSites || [];
        const updated = [...new Set([...existing, ...uniqueDomains])];

        chrome.storage.local.set({ allowedSites: updated });
      });
    });
  }

});

function syncSessionState() {
  if (!session.active || !session.startTime || !session.duration) {
    return;
  }

  const totalElapsed = Date.now() - session.totalStartTime;

  if (totalElapsed >= session.totalDuration) {
    stopSessionState();
    chrome.storage.local.remove(["allowedSites"]);
    broadcast({ type: "SESSION_COMPLETE" });
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
    session.mode = "FOCUS";
    session.duration = session.focusDuration;
  }
}

function stopSessionState() {
  session.active = false;
  session.mode = "IDLE";
  session.startTime = null;
  session.duration = 0;
  session.totalStartTime = null;
  session.totalDuration = 0;
  session.focusDuration = 0;
  session.breakDuration = 0;
  session.warned5 = false;
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

function getTotalRemainingTime() {
  if (!session.active || !session.totalStartTime) {
    return 0;
  }

  return Math.max(session.totalDuration - (Date.now() - session.totalStartTime), 0);
}
