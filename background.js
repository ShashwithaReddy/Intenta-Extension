try {
  importScripts("config.js");
} catch (error) {
  console.warn("Intenta config.js not loaded; AI backend config may be missing.");
}

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
  aiEnabled: false,
  warned5: false,
  distractionsClosed: 0,
  sitesAdded: 0,
  addedDomains: new Set(),
  aiReflections: [],
  focusQuality: createFocusQuality()
};

const DEFAULT_FOCUS_MINUTES = 50;
const DEFAULT_BREAK_MINUTES = 10;
const DEFAULT_CYCLES = 3;
const SESSION_STATE_KEY = "sessionState";
const AI_BACKEND_URL = globalThis.INTENTA_CONFIG?.AI_BACKEND_URL;
const INTENTA_BETA_KEY = globalThis.INTENTA_CONFIG?.BETA_KEY;
const BETA_KEY_PLACEHOLDER = "PASTE_BETA_KEY_HERE";

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
    const focusGoal = message.data?.focusGoal?.trim() || "";
    const aiEnabled = message.data?.aiEnabled !== false && Boolean(focusGoal);

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
    session.aiEnabled = aiEnabled;
    session.duration = session.focusDuration;
    session.warned5 = false;
    session.distractionsClosed = 0;
    session.sitesAdded = 0;
    session.addedDomains = new Set();
    session.aiReflections = [];
    session.focusQuality = createFocusQuality();
    persistSessionState();
    broadcast({ type: "SESSION_STARTED" });
    broadcastSessionStateUpdated();

    console.log("Focus session started");
  }

  // 🔹 STOP SESSION
  else if (message.type === "STOP_SESSION") {
    saveStoppedSession();
    stopSessionState();

    chrome.storage.local.remove(["allowedSites"], () => {
      broadcast({ type: "SESSION_STOPPED" });
      broadcastSessionStateUpdated();
      console.log("Session cleared");
    });

    console.log("Session stopped");
  }

  // 🔹 PAUSE SESSION
  else if (message.type === "PAUSE_SESSION") {
    if (session.active && !session.paused) {
      const remainingAtPause = getRemainingTime();
      flushFocusQualityContext();

      session.paused = true;
      session.pausedAt = Date.now();
      session.remainingAtPause = remainingAtPause;
      session.previousModeBeforePause = session.mode;
      session.mode = "PAUSED";
      persistSessionState();
      broadcastSessionStateUpdated();
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
      broadcastSessionStateUpdated();

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
      aiEnabled: session.aiEnabled === true,
      focusMinutes: session.focusDuration / 60 / 1000,
      breakMinutes: session.breakDuration / 60 / 1000
    });
  }

  // 🔹 SET ALLOWED SITES
  else if (message.type === "SET_ALLOWED_SITES" || message.type === "UPDATE_ALLOWED_SITES") {
    const domains = message.data.domains;
    const uniqueDomains = [...new Set(domains)];

    chrome.storage.local.set({ allowedSites: uniqueDomains }, () => {
      broadcastSessionStateUpdated();
    });
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
        broadcastSessionStateUpdated();
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
          broadcastSessionStateUpdated();
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

  // 🔹 SAVE AI REFLECTION
  else if (message.type === "SAVE_AI_REFLECTION") {
    if (!shouldRunIntelligence()) {
      sendResponse({ success: false });
      return;
    }

    if (!Array.isArray(session.aiReflections)) {
      session.aiReflections = [];
    }

    session.aiReflections.push({
      url: message.data?.url || "",
      title: message.data?.title || "",
      focusGoal: message.data?.focusGoal || session.focusGoal || "",
      reason: message.data?.reason || "Skip",
      aiAlignment: message.data?.aiAlignment || "",
      aiConfidence: message.data?.aiConfidence ?? 0,
      aiReason: message.data?.aiReason || "",
      timestamp: message.data?.timestamp || Date.now()
    });

    updateFocusQualityReflection(message.data?.url, message.data?.reason);
    persistSessionState();
    sendResponse({ success: true });
  }

  // 🔹 RECORD AI FOCUS QUALITY CONTEXT
  else if (message.type === "RECORD_AI_FOCUS_CONTEXT") {
    if (!shouldRunIntelligence()) {
      sendResponse({ success: false });
      return;
    }

    recordFocusQualityContext(message.data || {});
    sendResponse({ success: true });
  }

  // 🔹 FLUSH FOCUS QUALITY CONTEXT
  else if (message.type === "FLUSH_FOCUS_QUALITY_CONTEXT") {
    flushFocusQualityContext();
    persistSessionState();
    sendResponse({ success: true });
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
    flushFocusQualityContext();
    session.mode = "BREAK";
    session.duration = session.breakDuration;
    persistSessionState();
    broadcastSessionStateUpdated();
  } else if (session.mode === "BREAK") {
    if (session.currentCycle >= session.totalCycles) {
      flushFocusQualityContext();
      const summary = buildSessionSummary();
      saveSessionHistory(summary);
      broadcast({
        type: "SESSION_COMPLETE",
        summary
      });
      broadcast({ type: "SESSION_COMPLETED" });
      stopSessionState();
      chrome.storage.local.remove(["allowedSites"], () => {
        broadcastSessionStateUpdated();
      });
      return;
    }

    session.currentCycle++;
    session.mode = "FOCUS";
    session.duration = session.focusDuration;
    persistSessionState();
    broadcastSessionStateUpdated();
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
  session.aiEnabled = false;
  session.warned5 = false;
  session.distractionsClosed = 0;
  session.sitesAdded = 0;
  session.addedDomains = new Set();
  session.aiReflections = [];
  session.focusQuality = createFocusQuality();
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

function createFocusQuality() {
  return {
    alignedSeconds: 0,
    possiblyRelatedSeconds: 0,
    backgroundSeconds: 0,
    notAlignedSeconds: 0,
    unclearSeconds: 0,
    intentionalContinueSeconds: 0,
    distractedContinueSeconds: 0,
    aiEvents: [],
    currentContext: null
  };
}

function ensureFocusQuality() {
  if (!session.focusQuality) {
    session.focusQuality = createFocusQuality();
  }

  [
    "alignedSeconds",
    "possiblyRelatedSeconds",
    "backgroundSeconds",
    "notAlignedSeconds",
    "unclearSeconds",
    "intentionalContinueSeconds",
    "distractedContinueSeconds"
  ].forEach((key) => {
    if (!Number.isFinite(session.focusQuality[key])) {
      session.focusQuality[key] = 0;
    }
  });

  if (!Array.isArray(session.focusQuality.aiEvents)) {
    session.focusQuality.aiEvents = [];
  }

  return session.focusQuality;
}

function recordFocusQualityContext(context) {
  if (!shouldRunIntelligence()) return;

  const focusQuality = ensureFocusQuality();
  const now = Date.now();

  flushFocusQualityContext(now);

  focusQuality.currentContext = {
    url: context.url || "",
    title: context.title || "",
    domain: context.domain || "",
    alignment: context.alignment || "UNCLEAR",
    confidence: context.confidence ?? 0,
    reason: context.reason || "",
    reflectionReason: null,
    continueCategory: null,
    startedAt: now
  };

  focusQuality.aiEvents.push({
    url: focusQuality.currentContext.url,
    title: focusQuality.currentContext.title,
    domain: focusQuality.currentContext.domain,
    alignment: focusQuality.currentContext.alignment,
    confidence: focusQuality.currentContext.confidence,
    reason: focusQuality.currentContext.reason,
    startedAt: now
  });

  persistSessionState();
}

function updateFocusQualityReflection(url, reflectionReason) {
  const focusQuality = ensureFocusQuality();
  const context = focusQuality.currentContext;

  if (!context || context.url !== url) return;

  context.reflectionReason = reflectionReason || "Skip";

  if (reflectionReason === "Needed for my work") {
    context.continueCategory = "intentional";
  } else if (
    reflectionReason === "Just curious" ||
    reflectionReason === "I got distracted" ||
    reflectionReason === "Skip" ||
    !reflectionReason
  ) {
    context.continueCategory = "distracted";
  } else {
    context.continueCategory = null;
  }
}

function flushFocusQualityContext(endedAt = Date.now()) {
  const focusQuality = ensureFocusQuality();
  const context = focusQuality.currentContext;

  if (!context) return;

  if (session.active && !session.paused && session.mode === "FOCUS") {
    const elapsedSeconds = Math.max((endedAt - context.startedAt) / 1000, 0);
    addFocusQualitySeconds(context, elapsedSeconds);
  }

  focusQuality.currentContext = null;
}

function addFocusQualitySeconds(context, elapsedSeconds) {
  const focusQuality = ensureFocusQuality();

  if (context.alignment === "ALIGNED") {
    focusQuality.alignedSeconds += elapsedSeconds;
  } else if (context.alignment === "POSSIBLY_RELATED") {
    focusQuality.possiblyRelatedSeconds += elapsedSeconds;
  } else if (context.alignment === "ALLOWED_BACKGROUND") {
    focusQuality.backgroundSeconds += elapsedSeconds;
  } else if (context.alignment === "NOT_ALIGNED") {
    focusQuality.notAlignedSeconds += elapsedSeconds;
  } else {
    focusQuality.unclearSeconds += elapsedSeconds;
  }

  if (context.continueCategory === "intentional") {
    focusQuality.intentionalContinueSeconds += elapsedSeconds;
  } else if (context.continueCategory === "distracted") {
    focusQuality.distractedContinueSeconds += elapsedSeconds;
  }
}

function secondsToMinutes(seconds) {
  return Math.round((seconds / 60) * 10) / 10;
}

function buildFocusQualitySummary() {
  const focusQuality = ensureFocusQuality();

  return {
    alignedMinutes: secondsToMinutes(focusQuality.alignedSeconds || 0),
    possiblyRelatedMinutes: secondsToMinutes(focusQuality.possiblyRelatedSeconds || 0),
    backgroundMinutes: secondsToMinutes(focusQuality.backgroundSeconds || 0),
    notAlignedMinutes: secondsToMinutes(focusQuality.notAlignedSeconds || 0),
    unclearMinutes: secondsToMinutes(focusQuality.unclearSeconds || 0),
    intentionalContinueMinutes: secondsToMinutes(focusQuality.intentionalContinueSeconds || 0),
    distractedContinueMinutes: secondsToMinutes(focusQuality.distractedContinueSeconds || 0)
  };
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
    aiEnabled: session.aiEnabled === true,
    cyclesCompleted: session.totalCycles || session.currentCycle || 0,
    totalCycles: session.totalCycles || 0,
    focusMinutes,
    breakMinutes,
    focusTimeFormatted: formatDuration(focusMinutes),
    breakTimeFormatted: formatDuration(breakMinutes),
    distractionsClosed: session.distractionsClosed || 0,
    sitesAdded: session.sitesAdded || 0,
    aiReflections: session.aiReflections || [],
    aiReflectionsCount: (session.aiReflections || []).length,
    focusQuality: buildFocusQualitySummary()
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

  flushFocusQualityContext();

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
    aiEnabled: session.aiEnabled === true,
    completedCycles: Math.max((session.currentCycle || 0) - 1, 0),
    totalCycles: session.totalCycles,
    focusMinutesSpent: Math.round(elapsedMinutes),
    sitesAdded: session.sitesAdded || 0,
    distractionsClosed: session.distractionsClosed || 0,
    aiReflections: session.aiReflections || [],
    aiReflectionsCount: (session.aiReflections || []).length,
    focusQuality: buildFocusQualitySummary()
  };

  addToSessionHistory(historyItem);
}

function serializeSessionState() {
  return {
    ...session,
    addedDomains: [...session.addedDomains],
    aiReflections: session.aiReflections || [],
    focusQuality: session.focusQuality || createFocusQuality()
  };
}

function restoreSessionState(savedSession) {
  session = {
    ...session,
    ...savedSession,
    focusGoal: savedSession.focusGoal || "",
    aiEnabled: savedSession.aiEnabled === undefined
      ? Boolean(savedSession.focusGoal)
      : savedSession.aiEnabled === true,
    addedDomains: new Set(savedSession.addedDomains || []),
    aiReflections: savedSession.aiReflections || [],
    focusQuality: savedSession.focusQuality || createFocusQuality()
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

function broadcastSessionStateUpdated() {
  broadcast({ type: "SESSION_STATE_UPDATED" });
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
    session.aiEnabled === true &&
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

  if (!AI_BACKEND_URL) {
    console.warn("Intenta backend URL is not configured.");
    return {
      alignment: "UNCLEAR",
      confidence: 0,
      reason: "Intenta backend URL is not configured."
    };
  }

  if (!INTENTA_BETA_KEY || INTENTA_BETA_KEY === BETA_KEY_PLACEHOLDER) {
    console.warn("Intenta beta key is not configured.");
    return {
      alignment: "UNCLEAR",
      confidence: 0,
      reason: "Intenta beta key is not configured."
    };
  }

  const payload = {
    focusGoal: data.focusGoal || session.focusGoal || "Focus Session",
    pageType: data.pageType || "UNKNOWN",
    title: data.title || "",
    url: data.url || "",
    domain: data.domain || ""
  };

  const response = await fetch(AI_BACKEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Intenta-Beta-Key": INTENTA_BETA_KEY
    },
    body: JSON.stringify(payload)
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
