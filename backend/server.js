require("dotenv").config();

const cors = require("cors");
const express = require("express");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || "development";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const INTENTA_BETA_KEY = process.env.INTENTA_BETA_KEY || "";
const AI_CACHE_TTL = 10 * 60 * 1000;
const aiCache = new Map();
const ALIGNMENTS = new Set([
  "ALIGNED",
  "POSSIBLY_RELATED",
  "ALLOWED_BACKGROUND",
  "NOT_ALIGNED",
  "UNCLEAR"
]);

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not configured.");
  process.exit(1);
}

app.use(express.json({ limit: "64kb" }));
app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Intenta-Beta-Key"]
}));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too Many Requests"
}));

app.get("/", (req, res) => {
  res.json({
    service: "Intenta AI Backend",
    status: "healthy"
  });
});

app.use(requireBetaKey);

app.post("/classify-intent", async (req, res) => {
  try {
    const body = validateClassifyIntentRequest(req.body || {});
    const cacheKey = getCacheKey(body);
    const cached = aiCache.get(cacheKey);

    if (cached && Date.now() < cached.expiresAt) {
      console.log("Intenta backend AI cache hit");
      res.json(cached.result);
      return;
    }

    const result = await classifyIntent(body);

    if (result.alignment !== "UNCLEAR") {
      aiCache.set(cacheKey, {
        result,
        expiresAt: Date.now() + AI_CACHE_TTL
      });
    }

    res.json(result);
  } catch (error) {
    if (error.statusCode === 400) {
      res.status(400).json({ error: "Bad Request" });
      return;
    }

    console.error("Intent classification failed:", error);
    res.status(500).json({
      error: "AI classification failed."
    });
  }
});

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin.startsWith("chrome-extension://")) return true;

  const configuredOrigins = (process.env.INTENTA_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configuredOrigins.includes(origin)) return true;

  if (NODE_ENV !== "production") {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }

  return false;
}

function requireBetaKey(req, res, next) {
  if (!INTENTA_BETA_KEY) {
    next();
    return;
  }

  if (req.get("X-Intenta-Beta-Key") === INTENTA_BETA_KEY) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

function validateClassifyIntentRequest(body) {
  const payload = {
    focusGoal: validateStringField(body.focusGoal, "focusGoal", 300),
    pageType: validateStringField(body.pageType, "pageType", 100),
    title: validateStringField(body.title, "title", 500),
    url: validateStringField(body.url, "url", 2000),
    domain: validateStringField(body.domain, "domain", 253)
  };

  try {
    new URL(payload.url);
  } catch {
    throwBadRequest("url");
  }

  return payload;
}

function validateStringField(value, fieldName, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) {
    throwBadRequest(fieldName);
  }

  return value;
}

function throwBadRequest(fieldName) {
  const error = new Error(`Invalid ${fieldName}`);
  error.statusCode = 400;
  throw error;
}

function getCacheKey(body) {
  return JSON.stringify({
    focusGoal: body.focusGoal,
    pageType: body.pageType,
    domain: body.domain,
    title: body.title,
    url: body.url
  });
}

async function classifyIntent({ focusGoal, pageType, title, url, domain }) {
  const payload = {
    focusGoal: String(focusGoal || "Focus Session"),
    pageType: String(pageType || "UNKNOWN"),
    title: String(title || ""),
    url: String(url || ""),
    domain: String(domain || "")
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You classify whether a webpage likely supports a user's focus goal.",
            "Use only the provided title, domain, pageType, and URL.",
            "Return strict JSON only with keys: alignment, confidence, reason.",
            "alignment must be one of: ALIGNED, POSSIBLY_RELATED, ALLOWED_BACKGROUND, NOT_ALIGNED, UNCLEAR.",
            "ALIGNED means the page/video directly supports the user's focus goal, such as a Spring Boot REST API tutorial for a Spring Boot learning goal.",
            "POSSIBLY_RELATED means the page/video may support the goal indirectly or foundationally, such as a Java full course for a Spring Boot learning goal.",
            "ALLOWED_BACKGROUND means the content is not directly related to the goal, but could reasonably support focus as background audio, music, ambience, rain sounds, white noise, meditation music, calming instrumental music, classical music, lo-fi, or focus music.",
            "Background music should not be marked NOT_ALIGNED unless the title suggests active entertainment or distraction.",
            "NOT_ALIGNED means the content is clearly unrelated and likely distracting, such as gossip, movie trailers, prank videos, celebrity drama, reaction drama, spell or manifest instant money videos, random entertainment, or shorts-style dopamine content, unless the focus goal is about that topic.",
            "UNCLEAR means there is not enough information to decide.",
            "If uncertain, return UNCLEAR or POSSIBLY_RELATED.",
            "Do not over-classify.",
            "confidence must be a number from 0 to 1.",
            "reason must be one concise sentence."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(payload)
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  return normalizeAlignment(JSON.parse(content));
}

function normalizeAlignment(result) {
  const alignment = ALIGNMENTS.has(result.alignment)
    ? result.alignment
    : "UNCLEAR";
  const confidence = Number(result.confidence);

  return {
    alignment,
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0,
    reason: String(result.reason || "No reason provided.")
  };
}

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Environment: ${NODE_ENV}`);
});
