const express = require("express");

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const ALIGNMENTS = new Set([
  "ALIGNED",
  "POSSIBLY_RELATED",
  "ALLOWED_BACKGROUND",
  "NOT_ALIGNED",
  "UNCLEAR"
]);

app.use(express.json({ limit: "64kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.post("/classify-intent", async (req, res) => {
  try {
    const result = await classifyIntent(req.body || {});
    res.json(result);
  } catch (error) {
    console.error("Intent classification failed:", error);
    res.status(500).json({
      alignment: "UNCLEAR",
      confidence: 0,
      reason: "Unable to classify intent right now."
    });
  }
});

async function classifyIntent({ focusGoal, pageType, title, url, domain }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

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
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
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
  console.log(`Intenta AI backend listening on http://localhost:${PORT}`);
});
