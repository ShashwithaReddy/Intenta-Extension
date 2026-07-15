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
  let lastFocusGoalInput = "";
  let lastUrl = location.href;
  let currentYouTubeContext = null;
  let lastYouTubeContextKey = null;
  let lastLoggedYouTubeTypeKey = null;
  let isYouTubeAwarenessActive = false;
  let titleRetryTimer = null;
  let aiTitleRetryTimer = null;
  let aiTitleRetryCount = 0;
  let lastProcessedAiPageKey = null;
  let urlWatchInterval = null;
  const AI_CLASSIFICATION_CACHE_TTL = 10 * 60 * 1000;
  const aiClassificationCache = new Map();
  const aiInFlightRequests = new Map();
  const aiInterventionState = new Map();
  const aiInterventionTimers = new Map();
  const temporaryApprovals = new Map();
  const aiSuppressionUntilByScope = temporaryApprovals;
  const TEMPORARY_APPROVAL_MINUTES = 3;
  let lastAwarenessRefreshAt = 0;
  let awarenessRefreshPromise = null;
  let aiAutoResumeTimer = null;
  const videoInterventionSuppressUntil = new Map();
  let videoInterventionRecheckTimer = null;
  const productiveKeywords = [
    "tutorial",
    "course",
    "learn",
    "lecture",
    "interview",
    "system design",
    "spring boot",
    "react",
    "kubernetes",
    "docker",
    "leetcode",
    "coding",
    "programming",
    "development",
    "study",
    "guide",
    "how to",
    "roadmap",
    "career",
    "backend",
    "frontend",
    "engineering",
    "ai",
    "machine learning",
    "mathematics",
    "physics",
    "documentary"
  ];
  const distractionKeywords = [
    "spell",
    "manifest",
    "celebrity",
    "reaction",
    "drama",
    "gossip",
    "prank",
    "roast",
    "exposed",
    "fight",
    "crazy",
    "shocking",
    "viral",
    "clickbait",
    "shorts",
    "tiktok",
    "24 hours",
    "asmr",
    "compilation",
    "funny",
    "meme",
    "fails",
    "cringe",
    "instant money",
    "lottery"
  ];
  let youtubeInterventionState = {
    HOME_FEED: {
      suppressedUntil: 0
    },
    SHORTS: {
      suppressedUntil: 0
    }
  };

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

  function getGenericPageContext() {
    return {
      pageType: "WEB_PAGE",
      title: document.title || "",
      url: location.href,
      domain: location.hostname
    };
  }

  function getYouTubeAiPageType(ytType) {
    const pageTypes = {
      HOME_FEED: "YOUTUBE_HOME_FEED",
      SHORTS: "YOUTUBE_SHORTS",
      SEARCH_RESULTS: "YOUTUBE_SEARCH_RESULTS",
      WATCH_PAGE: "YOUTUBE_WATCH",
      SUBSCRIPTIONS: "YOUTUBE_SUBSCRIPTIONS",
      OTHER: "YOUTUBE_OTHER"
    };

    return pageTypes[ytType] || "YOUTUBE_OTHER";
  }

  function getPageContextForAi(ytType) {
    if (ytType) {
      return {
        pageType: getYouTubeAiPageType(ytType),
        title: document.title || "",
        url: location.href,
        domain: location.hostname
      };
    }

    return getGenericPageContext();
  }

  function normalizeUrlForAiCache(url) {
    try {
      const parsed = new URL(url);

      if (parsed.hostname.includes("youtube.com") && parsed.pathname === "/watch") {
        const videoId = parsed.searchParams.get("v");
        return videoId ? `youtube:watch:${videoId}` : parsed.href;
      }

      if (parsed.hostname.includes("youtube.com") && parsed.pathname.startsWith("/shorts/")) {
        return `youtube:shorts:${parsed.pathname}`;
      }

      parsed.search = "";
      parsed.hash = "";

      return `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return url;
    }
  }

  function buildAiCacheKey({ focusGoal, pageType, title, url, domain }) {
    return JSON.stringify({
      focusGoal: (focusGoal || "").trim().toLowerCase(),
      pageType,
      domain,
      title: (title || "").trim().toLowerCase(),
      url: normalizeUrlForAiCache(url)
    });
  }

  function getBestPageTitle() {
    if (location.hostname.includes("youtube.com")) {
      const ytTitle =
        currentYouTubeContext?.title ||
        document.querySelector("h1.ytd-watch-metadata")?.innerText?.trim() ||
        document.querySelector("h1.title")?.innerText?.trim();

      if (ytTitle && ytTitle !== "YouTube") {
        return ytTitle;
      }
    }

    return document.title?.trim() || "";
  }

  function buildAiPageKey(payload) {
    return JSON.stringify({
      focusGoal: payload.focusGoal,
      pageType: payload.pageType,
      domain: payload.domain,
      url: normalizeUrlForAiCache(payload.url),
      title: payload.title
    });
  }

  function retryAiWhenTitleReady() {
    if (aiTitleRetryCount >= 5) {
      console.log("Intenta AI skipped: title unavailable after retries");
      aiTitleRetryCount = 0;
      return;
    }

    clearTimeout(aiTitleRetryTimer);

    aiTitleRetryTimer = setTimeout(() => {
      aiTitleRetryCount++;
      runPageAwarenessIfFocus();
    }, 1000);
  }

  function isUnsupportedPageUrl(url) {
    return (
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("edge://") ||
      url.startsWith("about:")
    );
  }

  function isAllowedGoogleRedirectUrl(url) {
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

  function isFocusSessionActive(sessionState) {
    return (
      sessionState &&
      sessionState.active &&
      sessionState.paused !== true &&
      sessionState.mode === "FOCUS"
    );
  }

  async function getSessionState() {
    return sendMessageWithFallback({ type: "GET_SESSION_STATE" }, 1000);
  }

  async function shouldRunIntelligence() {
    const state = await getSessionState();

    return (
      state &&
      state.active === true &&
      state.aiEnabled === true &&
      state.paused !== true &&
      state.mode === "FOCUS"
    );
  }

  function startIntelligenceUrlWatcher() {
    if (urlWatchInterval) return;

    urlWatchInterval = setInterval(async () => {
      if (!(await shouldRunIntelligence())) {
        clearIntelligenceState();
        return;
      }

      if (location.href !== lastUrl) {
        safeSendMessage({ type: "FLUSH_FOCUS_QUALITY_CONTEXT" });
        lastUrl = location.href;
        lastProcessedAiPageKey = null;
        aiTitleRetryCount = 0;
        removeYouTubeInterventionOverlay();
        clearYouTubeTitleRetry();
        runPageAwarenessIfFocus();
      }
    }, 1000);
  }

  function stopIntelligenceUrlWatcher() {
    if (!urlWatchInterval) return;

    clearInterval(urlWatchInterval);
    urlWatchInterval = null;
  }

  async function runYouTubeAwarenessIfFocus() {
    if (!(await shouldRunIntelligence())) {
      clearIntelligenceState();
      return;
    }

    const state = await getSessionState();

    if (!isFocusSessionActive(state)) {
      clearIntelligenceState();
      return;
    }

    isYouTubeAwarenessActive = true;
    startIntelligenceUrlWatcher();

    const ytType = detectYouTubePageType();

    logYouTubeType(ytType);

    updateYouTubeContext(ytType);
    maybeShowYouTubeIntervention(ytType, state);
    maybeClassifyCurrentPageWithAi(state, ytType);
  }

  async function runPageAwarenessIfFocus() {
    return runYouTubeAwarenessIfFocus();
  }

  function clearYouTubeAwareness() {
    isYouTubeAwarenessActive = false;
    clearYouTubeTitleRetry();
    currentYouTubeContext = null;
    removeYouTubeInterventionOverlay();
    removeDistractionInterventionOverlay();
    removeAiFollowupOverlay();
  }

  function clearIntelligenceState() {
    clearYouTubeAwareness();
    clearVideoInterventionSuppressions();
    removeAiAwarenessOverlay();
    removeAiReflectionOverlay();
    stopIntelligenceUrlWatcher();
    lastYouTubeContextKey = null;
    lastLoggedYouTubeTypeKey = null;
    lastProcessedAiPageKey = null;
    aiTitleRetryCount = 0;
    clearTimeout(aiTitleRetryTimer);
    aiTitleRetryTimer = null;
  }

  function resetAiRuntimeState() {
    lastProcessedAiPageKey = null;
    aiTitleRetryCount = 0;

    if (aiTitleRetryTimer) {
      clearTimeout(aiTitleRetryTimer);
      aiTitleRetryTimer = null;
    }

    aiClassificationCache.clear();
    aiInFlightRequests.forEach((timer) => clearTimeout(timer));
    aiInFlightRequests.clear();
    aiSuppressionUntilByScope.clear();
    aiInterventionState.clear();
    aiInterventionTimers.forEach((timer) => clearTimeout(timer));
    aiInterventionTimers.clear();
    currentYouTubeContext = null;
    lastYouTubeContextKey = null;
    lastLoggedYouTubeTypeKey = null;

    if (aiAutoResumeTimer) {
      clearTimeout(aiAutoResumeTimer);
      aiAutoResumeTimer = null;
    }

    console.log("Intenta AI runtime state reset");
  }

  function resetAiAwarenessMemory() {
    resetAiRuntimeState();
  }

  function getTemporaryApprovalKeys(url = location.href) {
    const keys = [`url:${normalizeUrlForAiCache(url)}`];

    try {
      keys.push(`domain:${new URL(url).hostname}`);
    } catch {}

    return keys;
  }

  function grantTemporaryApproval(url = location.href, minutes = TEMPORARY_APPROVAL_MINUTES) {
    const expiresAt = Date.now() + minutes * 60 * 1000;

    getTemporaryApprovalKeys(url).forEach((key) => {
      temporaryApprovals.set(key, { expiresAt });
    });

    lastProcessedAiPageKey = null;
    removeBlockedOverlay();
  }

  function hasTemporaryApproval(url = location.href) {
    const now = Date.now();

    return getTemporaryApprovalKeys(url).some((key) => {
      const approval = temporaryApprovals.get(key);

      if (!approval) return false;

      if (approval.expiresAt <= now) {
        temporaryApprovals.delete(key);
        lastProcessedAiPageKey = null;
        return false;
      }

      return true;
    });
  }

  function isVideoInterventionSuppressed(url) {
    const until = videoInterventionSuppressUntil.get(url);
    return until && Date.now() < until;
  }

  function suppressVideoIntervention(url, minutes = 3) {
    videoInterventionSuppressUntil.set(
      url,
      Date.now() + minutes * 60 * 1000
    );
  }

  function clearVideoInterventionSuppressions() {
    videoInterventionSuppressUntil.clear();

    if (videoInterventionRecheckTimer) {
      clearTimeout(videoInterventionRecheckTimer);
      videoInterventionRecheckTimer = null;
    }
  }

  function scheduleVideoInterventionRecheck(videoUrl, minutes = 3) {
    if (videoInterventionRecheckTimer) {
      clearTimeout(videoInterventionRecheckTimer);
    }

    videoInterventionRecheckTimer = setTimeout(async () => {
      videoInterventionRecheckTimer = null;

      if (!(await shouldRunIntelligence())) return;
      if (location.href !== videoUrl) return;

      safeSendMessage({ type: "GET_SESSION_STATE" }, (state) => {
        if (!isFocusSessionActive(state)) return;
        if (location.href !== videoUrl) return;

        const score = currentYouTubeContext?.score;

        if (shouldShowDistractionIntervention(score)) {
          showDistractionIntervention(
            videoUrl,
            currentYouTubeContext.title,
            score
          );
        }
      });
    }, minutes * 60 * 1000);
  }

  function clearYouTubeTitleRetry() {
    if (titleRetryTimer) {
      clearTimeout(titleRetryTimer);
      titleRetryTimer = null;
    }
  }

  function getYouTubeVideoTitle() {
    const selectors = [
      "h1.ytd-watch-metadata yt-formatted-string",
      "ytd-watch-metadata h1 yt-formatted-string",
      "h1.title yt-formatted-string",
      "h1"
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();

      if (text && text !== "YouTube") return text;
    }

    return null;
  }

  function updateYouTubeContext(ytType) {
    if (!isYouTubeAwarenessActive) {
      return;
    }

    if (!ytType) {
      currentYouTubeContext = null;
      return;
    }

    if (ytType === "WATCH_PAGE") {
      clearYouTubeTitleRetry();
      logYouTubeVideoTitleWithRetry();
      return;
    }

    updateAndLogYouTubeContext(ytType, location.href, null);
  }

  function logYouTubeVideoTitleWithRetry(retries = 10) {
    if (!isYouTubeAwarenessActive) {
      return;
    }

    safeSendMessage({ type: "GET_SESSION_STATE" }, async (state) => {
      if (!(await shouldRunIntelligence())) {
        clearIntelligenceState();
        return;
      }

      if (!isFocusSessionActive(state)) {
        clearIntelligenceState();
        return;
      }

      if (detectYouTubePageType() !== "WATCH_PAGE") {
        return;
      }

      const title = getYouTubeVideoTitle();

      if (title) {
        titleRetryTimer = null;
        if (updateAndLogYouTubeContext("WATCH_PAGE", location.href, title)) {
          console.log("Intenta YouTube Video:", title);
          requestAiIntentAlignment(state.focusGoal, {
            pageType: "YOUTUBE_WATCH",
            title,
            url: location.href,
            domain: location.hostname
          });
        }
        return;
      }

      if (retries <= 0) {
        console.log("Intenta YouTube Video: title not found");
        return;
      }

      titleRetryTimer = setTimeout(async () => {
        titleRetryTimer = null;
        if (!(await shouldRunIntelligence())) return;
        logYouTubeVideoTitleWithRetry(retries - 1);
      }, 500);
    });
  }

  function logYouTubeType(ytType) {
    if (!ytType) return;

    const key = `${location.href}|${ytType}`;

    if (key === lastLoggedYouTubeTypeKey) {
      return;
    }

    lastLoggedYouTubeTypeKey = key;
    console.log("Intenta YouTube Type:", ytType);
  }

  function getYouTubeContextKey(type, url, title) {
    return `${type}|${url}|${title || ""}`;
  }

  function tokenizeTitle(title) {
    return title
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function keywordMatchesTitle(keyword, normalized, tokens) {
    return keyword.includes(" ")
      ? normalized.includes(keyword)
      : tokens.includes(keyword);
  }

  function scoreYouTubeTitle(title) {
    const normalized = title.toLowerCase();
    const tokens = tokenizeTitle(title);

    const productiveMatches = productiveKeywords.filter((keyword) =>
      keywordMatchesTitle(keyword, normalized, tokens)
    );

    const distractionMatches = distractionKeywords.filter((keyword) =>
      keywordMatchesTitle(keyword, normalized, tokens)
    );

    let category = "NEUTRAL";

    if (productiveMatches.length > distractionMatches.length) {
      category = "LIKELY_INTENTIONAL";
    } else if (distractionMatches.length > productiveMatches.length) {
      category = "LIKELY_DISTRACTION";
    }

    return {
      title,
      productiveScore: productiveMatches.length,
      distractionScore: distractionMatches.length,
      productiveMatches,
      distractionMatches,
      category
    };
  }

  function shouldShowDistractionIntervention(score) {
    return (
      score &&
      score.category === "LIKELY_DISTRACTION" &&
      score.distractionScore >= 1
    );
  }

  function updateAndLogYouTubeContext(type, url, title) {
    if (!isYouTubeAwarenessActive) return false;

    const key = getYouTubeContextKey(type, url, title);

    if (key === lastYouTubeContextKey) {
      return false;
    }

    lastYouTubeContextKey = key;
    const score = type === "WATCH_PAGE" && title
      ? scoreYouTubeTitle(title)
      : null;

    if (score) {
      console.table({
        title: score.title,
        category: score.category,
        productiveScore: score.productiveScore,
        distractionScore: score.distractionScore,
        productiveMatches: score.productiveMatches.join(", "),
        distractionMatches: score.distractionMatches.join(", ")
      });

      if (shouldShowDistractionIntervention(score)) {
        showDistractionIntervention(url, title, score);
      }
    }

    currentYouTubeContext = {
      type,
      url,
      title,
      score,
      updatedAt: Date.now()
    };

    console.log("Intenta YouTube Context:", currentYouTubeContext);
    return true;
  }

  async function maybeClassifyCurrentPageWithAi(state, ytType) {
    if (!(await shouldRunIntelligence())) return;
    if (!isFocusSessionActive(state)) return;
    if (isUnsupportedPageUrl(location.href)) return;
    if (isAllowedGoogleRedirectUrl(location.href)) return;
    if (hasTemporaryApproval(location.href)) return;
    if (ytType === "WATCH_PAGE") return;

    const pageContext = getPageContextForAi(ytType);

    if (!pageContext.title && !pageContext.url) return;

    requestAiIntentAlignment(state.focusGoal || "Focus Session", pageContext);
  }

  async function requestAiIntentAlignment(focusGoal, pageContext) {
    if (!(await shouldRunIntelligence())) return;
    if (hasTemporaryApproval(pageContext?.url || location.href)) return;

    const title = getBestPageTitle();

    if (!title || title === "YouTube") {
      console.log("Intenta AI skipped: title not ready", {
        url: location.href,
        title
      });
      retryAiWhenTitleReady();
      return;
    }

    const payload = {
      focusGoal: focusGoal || "Focus Session",
      ...pageContext,
      title
    };
    const pageKey = buildAiPageKey(payload);

    if (pageKey === lastProcessedAiPageKey) {
      console.log("Intenta AI skipped: page already processed");
      return;
    }

    lastProcessedAiPageKey = pageKey;
    aiTitleRetryCount = 0;

    const cacheKey = buildAiCacheKey(payload);
    const cached = aiClassificationCache.get(cacheKey);

    if (cached && Date.now() < cached.expiresAt) {
      console.log("Intenta AI Cache Hit:", cached.result);
      await handleAiResult(cached.result, payload);
      lastProcessedAiPageKey = null;
      return;
    }

    if (aiInFlightRequests.has(cacheKey)) {
      console.log("Intenta AI request already in-flight:", cacheKey);
      return;
    }

    console.log("Intenta AI Payload:", payload);

    const inFlightCleanupTimer = setTimeout(() => {
      aiInFlightRequests.delete(cacheKey);
    }, 30000);

    aiInFlightRequests.set(cacheKey, inFlightCleanupTimer);

    safeSendMessage({
      type: "AI_CLASSIFY_INTENT",
      data: payload
    }, async (result) => {
      clearTimeout(inFlightCleanupTimer);
      aiInFlightRequests.delete(cacheKey);

      if (!result) return;

      if (
        !payload.title ||
        payload.title === "YouTube" ||
        result.alignment === "UNCLEAR"
      ) {
        console.log("Intenta AI result not cached due to weak context", {
          title: payload.title,
          result
        });
      } else {
        aiClassificationCache.set(cacheKey, {
          result,
          expiresAt: Date.now() + AI_CLASSIFICATION_CACHE_TTL
        });
        console.log("Intenta AI Cache Stored:", result);
      }

      await handleAiResult(result, payload);
    });
  }

  async function handleAiResult(result, payload) {
    if (!(await shouldRunIntelligence())) return;
    if (payload.url !== location.href) return;
    if (hasTemporaryApproval(payload.url)) return;

    console.log("Intenta AI Alignment:", result);
    safeSendMessage({
      type: "RECORD_AI_FOCUS_CONTEXT",
      data: {
        url: payload.url,
        title: payload.title,
        domain: payload.domain,
        alignment: result.alignment,
        confidence: result.confidence,
        reason: result.reason,
        startedAt: Date.now()
      }
    });
    maybeShowAiAwarenessOverlay(result, payload.focusGoal || "Focus Session", payload);
  }

  runYouTubeAwarenessIfFocus();

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
        const result = await action();
        if (successText && result !== false) showToast(successText);
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

  async function maybeShowAiAwarenessOverlay(result, focusGoal, pageContext) {
    if (!(await shouldRunIntelligence())) return;
    if (!result || result.alignment !== "NOT_ALIGNED") return;
    if (Number(result.confidence) < 0.8) return;
    if (hasTemporaryApproval(pageContext?.url || location.href)) return;

    const urlKey = location.href;
    const state = aiInterventionState.get(urlKey);
    const now = Date.now();

    if (state?.cooldownUntil && state.cooldownUntil > now) {
      return;
    }

    if (
      shadow.getElementById("intenta-ai-awareness-overlay") ||
      shadow.getElementById("intenta-ai-reflection-overlay") ||
      shadow.getElementById("intenta-ai-followup-overlay")
    ) {
      return;
    }

    const interventionNumber = (state?.continueCount || 0) + 1;

    if (interventionNumber >= 3) {
      showAiNeedBreakOverlay({ focusGoal, aiResult: result, pageContext });
      return;
    }

    if (interventionNumber === 2) {
      showAiStillIntentionalOverlay({ focusGoal, aiResult: result, pageContext });
      return;
    }

    showAiAwarenessOverlay({
      goal: focusGoal,
      reason: result.reason || "This content appears unrelated to your focus.",
      aiResult: result,
      pageContext
    });
  }

  function showAiAwarenessOverlay({ goal, reason, aiResult, pageContext }) {
    removeAiAwarenessOverlay();

    const overlay = document.createElement("div");
    overlay.id = "intenta-ai-awareness-overlay";

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

    overlay.innerHTML = `
      <div style="
        width: calc(100% - 32px);
        max-width: 420px;
        background: #111;
        color: white;
        padding: 24px;
        border-radius: 16px;
        text-align: center;
        line-height: 1.45;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.4);
      ">
        <p style="font-size:22px;font-weight:700;">🤔 Pause for a second</p>
        <p style="font-size:14px;opacity:0.84;">This content doesn't appear related to:</p>
        <p style="font-size:15px;font-weight:700;">"${goal || "Focus Session"}"</p>
        <div style="
          width: 100%;
          background: #181818;
          border: 1px solid #333;
          border-radius: 12px;
          padding: 12px;
          text-align: left;
          font-size: 13px;
          color: rgba(255,255,255,0.82);
        ">
          <strong>AI reason:</strong><br />
          ${reason}
        </div>
        <p style="font-size:14px;font-weight:600;">Continue intentionally?</p>
        <button id="aiContinue">Continue for 3 min</button>
        <button id="aiLeave">Leave</button>
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    shadow.getElementById("aiContinue").addEventListener("click", () => {
      const url = pageContext?.url || location.href;
      setAiInterventionCooldown(url, TEMPORARY_APPROVAL_MINUTES, goal || "Focus Session", pageContext);
      overlay.remove();
      showToast("Continuing intentionally for 3 minutes");
    });

    shadow.getElementById("aiLeave").addEventListener("click", () => {
      overlay.remove();

      if (detectYouTubePageType() === "SHORTS") {
        window.history.back();
        return;
      }

      window.location.href = "https://www.google.com";
    });
  }

  function removeAiAwarenessOverlay() {
    const overlay = shadow.getElementById("intenta-ai-awareness-overlay");
    if (overlay) overlay.remove();
  }

  async function getGuidedPauseMinutes(minimumMinutes = 1) {
    const state = await getSessionState();
    const breakMinutes = Number(state?.breakMinutes) || 10;
    return Math.max(
      minimumMinutes,
      Math.round(Math.max(breakMinutes / 3, breakMinutes / 4))
    );
  }

  async function pauseSessionForGuidedBreak(minutes) {
    await sendMessageWithFallback({ type: "PAUSE_SESSION" });
    clearIntelligenceState();
    clearPauseOverlays();
    renderSessionState();
    showToast(`Focus session paused for ${minutes} minutes. Enjoy your break.`);

    if (aiAutoResumeTimer) {
      clearTimeout(aiAutoResumeTimer);
    }

    aiAutoResumeTimer = setTimeout(async () => {
      aiAutoResumeTimer = null;
      await sendMessageWithFallback({ type: "RESUME_SESSION" });
      renderSessionState();
      startSessionStateUpdates();
    }, minutes * 60 * 1000);
  }

  function setAiInterventionCooldown(url, minutes, focusGoal, pageContext) {
    const existing = aiInterventionState.get(url) || {
      continueCount: 0,
      lastContinueAt: 0
    };
    const now = Date.now();

    aiInterventionState.set(url, {
      ...existing,
      continueCount: existing.continueCount + 1,
      lastContinueAt: now,
      cooldownUntil: now + minutes * 60 * 1000
    });

    grantTemporaryApproval(url, minutes);
    scheduleAiInterventionRecheck(url, minutes, focusGoal, pageContext);
  }

  function scheduleAiInterventionRecheck(url, minutes, focusGoal, pageContext) {
    if (aiInterventionTimers.has(url)) {
      clearTimeout(aiInterventionTimers.get(url));
    }

    const timer = setTimeout(async () => {
      aiInterventionTimers.delete(url);

      if (!(await shouldRunIntelligence())) return;
      if (location.href !== url) return;

      requestAiIntentAlignment(focusGoal || "Focus Session", {
        ...pageContext,
        url,
        title: currentYouTubeContext?.title || pageContext?.title || document.title || "",
        domain: pageContext?.domain || location.hostname
      });
    }, minutes * 60 * 1000);

    aiInterventionTimers.set(url, timer);
  }

  function returnToFocus() {
    if (detectYouTubePageType() === "SHORTS") {
      window.history.back();
      return;
    }

    window.location.href = "https://www.google.com";
  }

  function showAiReflectionOverlay({ url, title, focusGoal, aiResult, pageContext }) {
    removeAiReflectionOverlay();

    const overlay = document.createElement("div");
    overlay.id = "intenta-ai-reflection-overlay";

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

    const reasons = [
      "Intentional break",
      "Needed for my work",
      "Just curious",
      "I got distracted",
      "Skip"
    ];

    overlay.innerHTML = `
      <div style="
        width: calc(100% - 32px);
        max-width: 390px;
        background: #111;
        color: white;
        padding: 24px;
        border-radius: 16px;
        text-align: left;
        line-height: 1.45;
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.4);
      ">
        <div style="text-align:center;">
          <p style="font-size:20px;font-weight:700;">Quick check</p>
          <p style="font-size:14px;opacity:0.82;margin-top:6px;">Why are you continuing?</p>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${reasons.map((reason, index) => `
            <label style="
              display:flex;
              align-items:center;
              gap:8px;
              background:#181818;
              border:1px solid #333;
              border-radius:10px;
              padding:10px;
              cursor:pointer;
              font-size:14px;
            ">
              <input
                type="radio"
                name="aiReflectionReason"
                value="${reason}"
                ${index === 4 ? "checked" : ""}
                style="appearance:auto;width:auto;accent-color:#22c55e;"
              />
              <span>${reason}</span>
            </label>
          `).join("")}
        </div>
        <button id="aiReflectionContinue">Continue</button>
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    shadow.getElementById("aiReflectionContinue").addEventListener("click", async () => {
      const selected = shadow.querySelector("input[name='aiReflectionReason']:checked");
      const selectedReason = selected?.value || "Skip";

      safeSendMessage({
        type: "SAVE_AI_REFLECTION",
        data: {
          url,
          title,
          focusGoal,
          reason: selectedReason,
          aiAlignment: aiResult?.alignment,
          aiConfidence: aiResult?.confidence,
          aiReason: aiResult?.reason,
          timestamp: Date.now()
        }
      });

      overlay.remove();

      if (selectedReason === "Intentional break") {
        const pauseMinutes = await getGuidedPauseMinutes(1);
        setAiInterventionCooldown(url, pauseMinutes, focusGoal, pageContext);
        await pauseSessionForGuidedBreak(pauseMinutes);
        return;
      }

      const cooldownMinutes = selectedReason === "Needed for my work" ? 15 : 3;
      setAiInterventionCooldown(url, cooldownMinutes, focusGoal, pageContext);
    });
  }

  function removeAiReflectionOverlay() {
    const overlay = shadow.getElementById("intenta-ai-reflection-overlay");
    if (overlay) overlay.remove();
  }

  function showAiStillIntentionalOverlay({ focusGoal, aiResult, pageContext }) {
    removeAiFollowupOverlay();

    const overlay = document.createElement("div");
    overlay.id = "intenta-ai-followup-overlay";

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

    overlay.innerHTML = `
      <div style="
        width: calc(100% - 32px);
        max-width: 390px;
        background: #111;
        color: white;
        padding: 24px;
        border-radius: 16px;
        text-align: center;
        line-height: 1.45;
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.4);
      ">
        <p style="font-size:20px;font-weight:700;">Still intentional?</p>
        <p style="font-size:14px;opacity:0.82;">You've been on this content for a while.</p>
        <button id="aiStillContinue">Continue</button>
        <button id="aiReturnFocus">Return to Focus</button>
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    shadow.getElementById("aiStillContinue").addEventListener("click", () => {
      setAiInterventionCooldown(location.href, 5, focusGoal, pageContext);
      overlay.remove();
    });

    shadow.getElementById("aiReturnFocus").addEventListener("click", () => {
      overlay.remove();
      returnToFocus();
    });
  }

  function showAiNeedBreakOverlay({ focusGoal, aiResult, pageContext }) {
    removeAiFollowupOverlay();

    const overlay = document.createElement("div");
    overlay.id = "intenta-ai-followup-overlay";

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

    overlay.innerHTML = `
      <div style="
        width: calc(100% - 32px);
        max-width: 410px;
        background: #111;
        color: white;
        padding: 24px;
        border-radius: 16px;
        text-align: center;
        line-height: 1.45;
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.4);
      ">
        <p style="font-size:20px;font-weight:700;">Need a break?</p>
        <p style="font-size:14px;opacity:0.82;">You've continued this distraction multiple times.</p>
        <p style="font-size:14px;opacity:0.82;">Maybe a short break would help.</p>
        <button id="aiPauseSession">Pause Session</button>
        <button id="aiContinueAnyway">Continue Anyway</button>
        <button id="aiReturnFocus">Return to Focus</button>
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    shadow.getElementById("aiPauseSession").addEventListener("click", async () => {
      const pauseMinutes = await getGuidedPauseMinutes(2);
      setAiInterventionCooldown(location.href, pauseMinutes, focusGoal, pageContext);
      overlay.remove();
      await pauseSessionForGuidedBreak(pauseMinutes);
    });

    shadow.getElementById("aiContinueAnyway").addEventListener("click", () => {
      setAiInterventionCooldown(location.href, 5, focusGoal, pageContext);
      overlay.remove();
    });

    shadow.getElementById("aiReturnFocus").addEventListener("click", () => {
      overlay.remove();
      returnToFocus();
    });
  }

  function removeAiFollowupOverlay() {
    const overlay = shadow.getElementById("intenta-ai-followup-overlay");
    if (overlay) overlay.remove();
  }

  async function showDistractionIntervention(url, title, score) {
    if (!(await shouldRunIntelligence())) return;

    if (
      isVideoInterventionSuppressed(url) ||
      shadow.getElementById("intenta-distraction-overlay") ||
      document.getElementById("intenta-distraction-overlay") ||
      shadow.getElementById("intenta-block-overlay")
    ) {
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = "intenta-distraction-overlay";

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

    overlay.innerHTML = `
      <div style="
        width: calc(100% - 32px);
        max-width: 390px;
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
        <p style="font-size:20px;font-weight:700;">Stay intentional</p>
        <p style="font-size:14px;opacity:0.82;">This video may not support your current focus.</p>
        <p style="font-size:12px;opacity:0.6;">If you continue, Intenta will check in again in 3 minutes.</p>
        <button id="ytDistractionContinue">Continue for 3 min</button>
        <button id="ytDistractionLeave">Leave Video</button>
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    shadow.getElementById("ytDistractionContinue").addEventListener("click", () => {
      // TODO: Hard Mode after AI relevance scoring is stable.
      suppressVideoIntervention(url, 3);
      overlay.remove();
      scheduleVideoInterventionRecheck(url, 3);
    });

    shadow.getElementById("ytDistractionLeave").addEventListener("click", () => {
      overlay.remove();
      window.history.back();
    });
  }

  function removeDistractionInterventionOverlay() {
    const overlay = shadow.getElementById("intenta-distraction-overlay");
    if (overlay) overlay.remove();
  }

  async function maybeShowYouTubeIntervention(type, sessionState) {
    if (!(await shouldRunIntelligence())) {
      clearIntelligenceState();
      return;
    }

    if (!isFocusSessionActive(sessionState)) {
      clearIntelligenceState();
      return;
    }

    if (type !== "HOME_FEED" && type !== "SHORTS") {
      return;
    }

    const now = Date.now();

    if (youtubeInterventionState[type]?.suppressedUntil > now) {
      return;
    }

    if (shadow.getElementById("intenta-block-overlay")) return;

    showYouTubeInterventionOverlay(type);
  }

  function showYouTubeInterventionOverlay(type) {
    if (
      shadow.getElementById("intenta-youtube-overlay") ||
      document.getElementById("intenta-youtube-overlay")
    ) {
      return;
    }

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
        suppressYouTubeIntervention(type);
        focusYouTubeSearchInput();
        overlay.remove();
      });
    }

    continueButton.addEventListener("click", () => {
      suppressYouTubeIntervention(type);
      overlay.remove();
    });

    leaveButton.addEventListener("click", () => {
      youtubeInterventionState[type].suppressedUntil = 0;
      overlay.remove();
      if (type === "HOME_FEED") {
        window.location.href = "https://www.google.com/search?q=";
      } else {
        window.history.back();
      }
    });
  }

  function suppressYouTubeIntervention(type) {
    youtubeInterventionState[type].suppressedUntil = Date.now() + 30000;
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
      if (hasTemporaryApproval()) {
        removeBlockedOverlay();
        return;
      }
      showBlockedOverlay();
    }

    if (message.type === "CLEAR_OVERLAYS") {
      clearIntentaOverlays();
    }

    if (message.type === "SESSION_STARTED") {
      resetAiRuntimeState();
      refreshAwarenessForActiveTab();
    }

    if (message.type === "SESSION_STOPPED") {
      resetAiRuntimeState();
      clearIntelligenceState();
    }

    if (message.type === "SESSION_COMPLETED") {
      resetAiRuntimeState();
      clearIntelligenceState();
    }

    if (message.type === "SESSION_STATE_UPDATED") {
      console.log("Intenta: received session update");
      refreshAwarenessForActiveTab();
    }

    if (message.type === "SESSION_COMPLETE") {
      resetAiAwarenessMemory();
      clearIntelligenceState();
      clearIntentaOverlays();
      showCelebrationOverlay(message.summary);
      renderSessionState();
      stopSessionStateUpdates();
      playSuccessSound();
    }
  });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) return;

    console.log("Intenta: tab became visible");
    await refreshAwarenessForActiveTab();
  });

  window.addEventListener("focus", async () => {
    console.log("Intenta: window focused");
    await refreshAwarenessForActiveTab();
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
        if (hasTemporaryApproval()) {
          removeBlockedOverlay();
          return;
        }
        showBlockedOverlay();
      }
    }
  );

  async function refreshAwarenessForActiveTab() {
    const now = Date.now();

    if (awarenessRefreshPromise && now - lastAwarenessRefreshAt < 500) {
      return awarenessRefreshPromise;
    }

    lastAwarenessRefreshAt = now;
    awarenessRefreshPromise = (async () => {
      console.log("Intenta: tab activated");
      console.log("Intenta: refreshing awareness");
      await refreshSessionWidget();
      console.log("Intenta: rechecking page relevance");
      await runPageAwarenessIfFocus();
    })().finally(() => {
      awarenessRefreshPromise = null;
    });

    return awarenessRefreshPromise;
  }

  async function refreshSessionWidget() {
    const state = await sendMessageWithFallback({ type: "GET_SESSION_STATE" }, 500);
    if (state) {
      renderPanel(state);
    }
    refreshCurrentPageBlockingState();
    startSessionStateUpdates();
  }

  function refreshCurrentPageBlockingState() {
    safeSendMessage(
      {
        type: "PAGE_DATA",
        data: {
          title: document.title,
          url: window.location.href
        }
      },
      (response) => {
        if (!response) return;

        if (response.action === "BLOCK") {
          if (hasTemporaryApproval()) {
            removeBlockedOverlay();
            return;
          }
          showBlockedOverlay();
        } else {
          removeBlockedOverlay();
        }
      }
    );
  }

  function showBlockedOverlay() {
    if (hasTemporaryApproval()) {
      removeBlockedOverlay();
      return;
    }

    safeSendMessage({ type: "GET_SESSION_STATE" }, (state) => {
      if (!state?.active || state.mode !== "FOCUS") return;
      if (hasTemporaryApproval()) {
        removeBlockedOverlay();
        return;
      }
      renderBlockedOverlay();
    });
  }

  function renderBlockedOverlay() {
    if (hasTemporaryApproval()) return;

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
        <div id="goalText" style="font-weight: 600;">Goal: --</div>
        <div id="aiStatusText" style="font-size: 12px; opacity: 0.75; display:none;">AI Guidance: --</div>
        <div id="cycleText" style="font-weight: 600;">Cycle: -- / --</div>
        <div id="modeText" style="font-weight: 600;">Mode: IDLE</div>
        <div id="pausedFromText" style="font-size: 12px; opacity: 0.75; display:none;">Paused from: --</div>
        <div id="timeText" style="font-weight: 600;">Remaining: --:--</div>
        <div id="totalText" style="font-size: 12px; opacity: 0.7;">Total left: --:--:--</div>
      </div>
      <div id="session-config" style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
        <label for="focusGoal" style="font-size:12px;opacity:0.75;">Focus Goal</label>
        <input id="focusGoal" placeholder="e.g. Spring Boot learning, DSA, Work project" />
        <input id="cycles" placeholder="Cycles" />
        <input id="focusTime" placeholder="Focus (min)" />
        <input id="breakTime" placeholder="Break (min)" />
        <button id="start">Start Session</button>
      </div>
      <div style="margin-top:10px; border-top:1px solid #333;"></div>
      <button id="pause">Pause</button>
      <button id="resume">Resume</button>
      <button id="stop">Stop</button>
      <button id="tabs">Use Tabs</button>
      <button id="historyBtn">Session History</button>
    `;

    shadow.appendChild(panel);
    stylePanelControls(panel);

    const focusGoalInput = shadow.getElementById("focusGoal");
    focusGoalInput.value = lastFocusGoalInput;
    focusGoalInput.addEventListener("input", () => {
      lastFocusGoalInput = focusGoalInput.value;
    });

    withButtonFeedback(shadow.getElementById("start"), async () => {
      const focusGoal = shadow.getElementById("focusGoal").value.trim();

      if (!focusGoal) {
        showStartWithoutAiModal();
        return false;
      }

      await startSessionFromPanel(true);
    }, "Session started");

    withButtonFeedback(shadow.getElementById("stop"), async () => {
      await sendMessageWithFallback({ type: "STOP_SESSION" });
      resetAiAwarenessMemory();
      clearIntelligenceState();
      renderSessionState();
      stopSessionStateUpdates();
    }, "Session stopped");

    withButtonFeedback(shadow.getElementById("pause"), async () => {
      await sendMessageWithFallback({ type: "PAUSE_SESSION" });
      clearIntelligenceState();
      clearPauseOverlays();
      renderSessionState();
    }, "Session paused");

    withButtonFeedback(shadow.getElementById("resume"), async () => {
      if (aiAutoResumeTimer) {
        clearTimeout(aiAutoResumeTimer);
        aiAutoResumeTimer = null;
      }

      await sendMessageWithFallback({ type: "RESUME_SESSION" });
      renderSessionState();
      startSessionStateUpdates();
    }, "Session resumed");

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

  async function startSessionFromPanel(aiEnabled) {
    resetAiAwarenessMemory();
    clearIntelligenceState();

    const focusGoal = shadow.getElementById("focusGoal")?.value.trim() || "";
    lastFocusGoalInput = focusGoal;
    const cycles = Number(shadow.getElementById("cycles")?.value);
    const focus = Number(shadow.getElementById("focusTime")?.value);
    const breakTime = Number(shadow.getElementById("breakTime")?.value);

    await sendMessageWithFallback({
      type: "START_SESSION",
      data: {
        focus,
        break: breakTime,
        cycles,
        focusGoal,
        aiEnabled
      }
    });

    renderSessionState();
    startSessionStateUpdates();
  }

  function showStartWithoutAiModal() {
    const existing = shadow.getElementById("intenta-ai-goal-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "intenta-ai-goal-modal";
    overlay.className = "intenta-overlay";

    overlay.style = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.76);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: intentaOverlayFadeIn 180ms ease-out;
    `;

    overlay.innerHTML = `
      <div style="
        width: calc(100% - 32px);
        max-width: 430px;
        background: #111;
        color: white;
        padding: 24px;
        border-radius: 16px;
        text-align: left;
        line-height: 1.45;
        display: flex;
        flex-direction: column;
        gap: 14px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.4);
      ">
        <div style="text-align:center;">
          <p style="font-size:20px;font-weight:700;">Start without a focus goal?</p>
        </div>
        <p style="font-size:14px;opacity:0.85;">
          A focus goal helps Intenta understand which websites support your work and which ones may distract you.
        </p>
        <div style="font-size:14px;opacity:0.85;display:flex;flex-direction:column;gap:6px;">
          <div>Without a goal:</div>
          <div>• AI guidance will be disabled</div>
          <div>• Smart relevance detection will be disabled</div>
          <div>• Reflection prompts will be disabled</div>
        </div>
        <div style="font-size:14px;opacity:0.85;display:flex;flex-direction:column;gap:6px;">
          <div>You can still use:</div>
          <div>✓ Focus timer</div>
          <div>✓ Break timer</div>
          <div>✓ Allowed tabs</div>
          <div>✓ Session history</div>
        </div>
        <button id="continueWithoutAi">Continue without AI</button>
        <button id="goBackToGoal">Go back</button>
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    shadow.getElementById("continueWithoutAi").addEventListener("click", async () => {
      overlay.remove();
      await startSessionFromPanel(false);
      showToast("Session started");
    });

    shadow.getElementById("goBackToGoal").addEventListener("click", () => {
      overlay.remove();
      shadow.getElementById("focusGoal")?.focus();
    });
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
    const pause = shadow.getElementById("pause");
    const resume = shadow.getElementById("resume");
    const stop = shadow.getElementById("stop");
    const tabs = shadow.getElementById("tabs");
    const history = shadow.getElementById("historyBtn");

    if (start) start.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (pause) pause.style.cssText = `${buttonBaseStyle} background: #f59e0b; color: white;`;
    if (resume) resume.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
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
    const celebrationDone = container.querySelector("#intenta-celebration-done");
    const closeHistory = container.querySelector("#closeHistory");
    const clearHistory = container.querySelector("#clearHistoryBtn");
    const ytSearch = container.querySelector("#ytSearch");
    const ytContinue = container.querySelector("#ytContinue");
    const ytLeave = container.querySelector("#ytLeave");
    const ytDistractionContinue = container.querySelector("#ytDistractionContinue");
    const ytDistractionLeave = container.querySelector("#ytDistractionLeave");
    const aiContinue = container.querySelector("#aiContinue");
    const aiLeave = container.querySelector("#aiLeave");
    const aiReflectionContinue = container.querySelector("#aiReflectionContinue");
    const aiStillContinue = container.querySelector("#aiStillContinue");
    const aiReturnFocus = container.querySelector("#aiReturnFocus");
    const aiPauseSession = container.querySelector("#aiPauseSession");
    const aiContinueAnyway = container.querySelector("#aiContinueAnyway");
    const continueWithoutAi = container.querySelector("#continueWithoutAi");
    const goBackToGoal = container.querySelector("#goBackToGoal");

    if (add) add.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (back) back.style.cssText = `${buttonBaseStyle} background: #222; color: white;`;
    if (closeCelebration) closeCelebration.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (celebrationDone) celebrationDone.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (closeHistory) closeHistory.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (clearHistory) clearHistory.style.cssText = `${buttonBaseStyle} background: #ef4444; color: white;`;
    if (ytSearch) ytSearch.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (ytContinue) ytContinue.style.cssText = `${buttonBaseStyle} background: #222; color: white;`;
    if (ytLeave) ytLeave.style.cssText = `${buttonBaseStyle} background: #ef4444; color: white;`;
    if (ytDistractionContinue) ytDistractionContinue.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (ytDistractionLeave) ytDistractionLeave.style.cssText = `${buttonBaseStyle} background: #ef4444; color: white;`;
    if (aiContinue) aiContinue.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (aiLeave) aiLeave.style.cssText = `${buttonBaseStyle} background: #ef4444; color: white;`;
    if (aiReflectionContinue) aiReflectionContinue.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (aiStillContinue) aiStillContinue.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (aiReturnFocus) aiReturnFocus.style.cssText = `${buttonBaseStyle} background: #ef4444; color: white;`;
    if (aiPauseSession) aiPauseSession.style.cssText = `${buttonBaseStyle} background: #f59e0b; color: white;`;
    if (aiContinueAnyway) aiContinueAnyway.style.cssText = `${buttonBaseStyle} background: #222; color: white;`;
    if (continueWithoutAi) continueWithoutAi.style.cssText = `${buttonBaseStyle} background: #22c55e; color: white;`;
    if (goBackToGoal) goBackToGoal.style.cssText = `${buttonBaseStyle} background: #222; color: white;`;
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
      renderPanel(state);
    });
  }

  function hideAllSessionControls() {
    [
      "session-config",
      "start",
      "pause",
      "resume",
      "stop",
      "tabs",
      "historyBtn"
    ].forEach((id) => {
      const el = shadow.getElementById(id);
      if (el) el.style.display = "none";
    });
  }

  function renderPanel(state) {
    const cycleText = shadow.getElementById("cycleText");
    const goalText = shadow.getElementById("goalText");
    const aiStatusText = shadow.getElementById("aiStatusText");
    const modeText = shadow.getElementById("modeText");
    const pausedFromText = shadow.getElementById("pausedFromText");
    const timeText = shadow.getElementById("timeText");
    const totalText = shadow.getElementById("totalText");
    const config = shadow.getElementById("session-config");
    const start = shadow.getElementById("start");
    const pause = shadow.getElementById("pause");
    const resume = shadow.getElementById("resume");
    const stop = shadow.getElementById("stop");
    const tabs = shadow.getElementById("tabs");
    const history = shadow.getElementById("historyBtn");
    const badge = shadow.getElementById("intenta-timer-badge");
    const isActive = Boolean(state && state.active);
    const isPaused = isActive && (state.paused || state.mode === "PAUSED");
    const isFocus = isActive && state.mode === "FOCUS" && !isPaused;
    const isBreak = isActive && state.mode === "BREAK" && !isPaused;
    const mode = isActive ? state.mode : "IDLE";
    const remaining = format(state?.remaining || 0);
    const totalRemaining = formatLong(state?.totalRemaining || 0);

    hideAllSessionControls();

    if (state?.focusGoal) {
      lastFocusGoalInput = state.focusGoal;
    }

    if (goalText) {
      goalText.innerText = isActive && state.focusGoal
        ? `Goal: ${state.focusGoal}`
        : "Goal: --";
    }
    if (aiStatusText) {
      aiStatusText.innerText = `AI Guidance: ${state?.aiEnabled ? "ON" : "OFF"}`;
      aiStatusText.style.display = isActive ? "block" : "none";
    }
    if (cycleText) {
      cycleText.innerText = isActive
        ? `Cycle: ${state.currentCycle} / ${state.totalCycles}`
        : "Cycle: -- / --";
    }
    if (modeText) modeText.innerText = "Mode: " + mode;
    if (pausedFromText) {
      pausedFromText.innerText = `Paused from: ${state?.previousModeBeforePause || "FOCUS"}`;
      pausedFromText.style.display = isPaused ? "block" : "none";
    }
    if (timeText) timeText.innerText = "Remaining: " + remaining;
    if (totalText) totalText.innerText = "Total left: " + totalRemaining;

    if (!isActive || isBreak || isPaused) removeBlockedOverlay();
    if (isFocus) {
      runPageAwarenessIfFocus();
    } else {
      clearIntelligenceState();
    }

    if (!isActive) {
      if (config) config.style.display = "flex";
      if (start) start.style.display = "block";
      if (history) history.style.display = "block";
    } else if (isPaused) {
      if (resume) resume.style.display = "block";
      if (stop) stop.style.display = "block";
    } else if (isFocus || isBreak) {
      if (pause) pause.style.display = "block";
      if (stop) stop.style.display = "block";
      if (tabs) tabs.style.display = isFocus ? "block" : "none";
    }

    if (badge) {
      if (isActive) {
        badge.innerText = `${mode} ${remaining}`;
        badge.style.background = isPaused
          ? "#6b7280"
          : isBreak
            ? "#2563eb"
            : "#16a34a";
        badge.style.display = "block";
      } else {
        badge.style.display = "none";
      }
    }
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
      "#intenta-distraction-overlay",
      "#intenta-ai-awareness-overlay",
      "#intenta-ai-reflection-overlay",
      "#intenta-ai-followup-overlay",
      "#intenta-ai-goal-modal",
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

    shadow.querySelectorAll(".intenta-overlay").forEach((el) => {
      el.remove();
    });

    document.querySelectorAll(".intenta-overlay").forEach((el) => {
      el.remove();
    });
  }

  function clearPauseOverlays() {
    [
      "#intenta-block-overlay",
      "#intenta-youtube-overlay",
      "#intenta-distraction-overlay",
      "#intenta-ai-awareness-overlay",
      "#intenta-ai-reflection-overlay",
      "#intenta-ai-followup-overlay",
      "#intenta-ai-goal-modal",
      "#intenta-celebration-overlay",
      "#intenta-history-modal",
      "#intenta-toast"
    ].forEach((selector) => {
      const el = shadow.querySelector(selector) || document.querySelector(selector);
      if (el) el.remove();
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

  function getHistoryCardHtml(item) {
    const isStoppedEarly = item.status === "STOPPED_EARLY";
    const statusText = isStoppedEarly ? "🟡 Stopped Early" : "🟢 Completed";
    const quality = item.focusQuality || {};
    const completedCycles = isStoppedEarly
      ? item.completedCycles || 0
      : item.cyclesCompleted || 0;
    const focusLine = isStoppedEarly
      ? `Time spent: ${item.focusMinutesSpent || 0} min`
      : `Focus time: ${item.focusTimeFormatted || `${item.focusMinutes || 0} min`}`;

    return `
      <div style="
        background: #181818;
        border: 1px solid #333;
        border-radius: 10px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      ">
        <div style="font-weight:700;">${statusText}</div>
        <div style="font-size:12px;opacity:0.75;">Goal: ${item.focusGoal || "—"}</div>
        <div style="font-size:12px;opacity:0.75;">AI: ${item.aiEnabled === false ? "OFF" : "ON"}</div>
        <div style="font-size:13px;">Cycles: ${completedCycles} / ${item.totalCycles || 0}</div>
        <div style="font-size:13px;">${focusLine}</div>
        ${item.aiEnabled === false ? "" : `<div style="font-size:12px;opacity:0.75;">Aligned: ${formatQualityMinutes(quality.alignedMinutes)} • Unrelated continued: ${formatQualityMinutes(getUnrelatedContinuedMinutes(quality))}</div>`}
        <div style="font-size:12px;opacity:0.75;">Closed: ${item.distractionsClosed || 0} • Added: ${item.sitesAdded || 0}</div>
        ${item.aiEnabled === false ? "" : `<div style="font-size:12px;opacity:0.75;">AI reflections: ${item.aiReflectionsCount || item.aiReflections?.length || 0}</div>`}
        <div style="font-size:12px;opacity:0.6;">${formatHistoryDate(item.completedAt)}</div>
      </div>
    `;
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
      ? history.map(getHistoryCardHtml).join("")
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

  function formatQualityMinutes(value) {
    const minutes = Number(value) || 0;
    return `${minutes % 1 === 0 ? minutes : minutes.toFixed(1)} min`;
  }

  function getUnrelatedContinuedMinutes(quality = {}) {
    return (Number(quality.intentionalContinueMinutes) || 0) +
      (Number(quality.distractedContinueMinutes) || 0);
  }

  function showCelebrationOverlay(summary = {}) {
    const existing = shadow.getElementById("intenta-celebration-overlay");
    if (existing) existing.remove();
    const quality = summary.focusQuality || {};
    const unrelatedContinued = getUnrelatedContinuedMinutes(quality);

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
          <div><strong>Goal:</strong> ${summary.focusGoal || "—"}</div>
          <div><strong>Cycles:</strong> ${summary.cyclesCompleted || 0}/${summary.totalCycles || 0}</div>
          <div><strong>Focus time:</strong> ${summary.focusTimeFormatted || `${summary.focusMinutes || 0} min`}</div>
          <div><strong>Break time:</strong> ${summary.breakTimeFormatted || `${summary.breakMinutes || 0} min`}</div>
          <div><strong>Distractions closed:</strong> ${summary.distractionsClosed || 0}</div>
          <div><strong>Sites added to focus:</strong> ${summary.sitesAdded || 0}</div>
          <div><strong>AI Guidance:</strong> ${summary.aiEnabled === false ? "Disabled" : "Enabled"}</div>
          ${summary.aiEnabled === false ? "" : `<div><strong>AI reflections:</strong> ${summary.aiReflectionsCount || summary.aiReflections?.length || 0}</div>`}
        </div>
        ${summary.aiEnabled === false ? "" : `<div style="
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
          <div><strong>Focus quality:</strong></div>
          <div>Aligned: ${formatQualityMinutes(quality.alignedMinutes)}</div>
          <div>Possibly related: ${formatQualityMinutes(quality.possiblyRelatedMinutes)}</div>
          <div>Background: ${formatQualityMinutes(quality.backgroundMinutes)}</div>
          <div>Unrelated continued: ${formatQualityMinutes(unrelatedContinued)}</div>
          ${unrelatedContinued > 0 ? `<div style="font-size:12px;opacity:0.75;">Reflection: You continued unrelated content for ${formatQualityMinutes(unrelatedContinued)}.</div>` : ""}
        </div>`}
        <button id="intenta-celebration-done">Done</button>
      </div>
    `;

    shadow.appendChild(overlay);
    styleOverlayButtons(overlay);

    const doneBtn = shadow.getElementById("intenta-celebration-done");
    doneBtn.addEventListener("click", () => {
      console.log("Celebration Done clicked");
      clearIntentaOverlays();
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
