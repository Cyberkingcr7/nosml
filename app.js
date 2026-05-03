require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const axios = require("axios");
const natural = require("natural");
const pdfParse = require("pdf-parse");
const { MongoClient } = require("mongodb");
const { OAuth2Client } = require("google-auth-library");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_API_KEY // set in your .env
});
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_KEY = process.env.ADMIN_KEY || "bnh-admin";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY;

const mongoClient = new MongoClient(MONGO_URI);
let db, usersCollection;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function connectDB() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await mongoClient.connect();
    db = mongoClient.db("clipmind");
    usersCollection = db.collection("users");
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ Failed to connect to MongoDB:", err);
    process.exit(1);
  }
}

// ----------------------
// Verify Google Token
// ----------------------
async function verifyGoogleToken(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
}

// ----------------------
// Fetch User Profile
// ----------------------
app.get("/api/users/profile", async (req, res) => {
  const { email, idToken } = req.query;
  if (!email || !idToken) return res.status(400).json({ status: "error", message: "Missing params" });

  try {
    const payload = await verifyGoogleToken(idToken);
    if (payload.email !== email) return res.status(403).json({ status: "error", message: "Email mismatch" });

    const user = await usersCollection.findOne({ email });
    if (!user) return res.json({ status: "ok", apiKey: null, paymentStatus: "unpaid", expiresAt: null, planType: null });

    res.json({
      status: "ok",
      apiKey: user.apiKey,
      paymentStatus: user.paymentStatus || "unpaid",
      expiresAt: user.expiresAt,
      planType: user.planType || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: "Server error" });
  }
});

// ----------------------
// Admin Key Generator
// ----------------------
app.post("/api/admin/generate", async (req, res) => {
  const { adminKey, email, duration } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ status: "error", message: "Forbidden" });
  if (!email || !duration) return res.status(400).json({ status: "error", message: "Missing fields" });

  try {
    let apiKey = "bnh-" + crypto.randomBytes(3).toString("hex");
    const expiresAt = new Date();
    let planType = "monthly";
    if (duration === "1 day") { expiresAt.setDate(expiresAt.getDate() + 1); planType="daily"; }
    else expiresAt.setDate(expiresAt.getDate() + 30);

    await usersCollection.updateOne(
      { email },
      { $set: { email, apiKey, expiresAt, paymentStatus: "paid", planType } },
      { upsert: true }
    );

    return res.json({ status: "ok", apiKey, expiresAt, planType, message: `Key generated for ${email}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: "Server error" });
  }
});

// ----------------------
// Admin Custom Key Generator
// ----------------------
app.post("/api/admin/generate-custom", async (req, res) => {
  const { adminKey, email, customName, duration } = req.body;

  // Validate admin key
  if (adminKey !== ADMIN_KEY) {
    return res.status(403).json({ status: "error", message: "Invalid admin key" });
  }

  // Validate required fields
  if (!email || !customName || !duration) {
    return res.status(400).json({ status: "error", message: "Missing fields" });
  }

  // Validate customName format (alphanumeric + hyphens only)
  if (!/^[a-zA-Z0-9-]+$/.test(customName)) {
    return res.status(400).json({ status: "error", message: "Custom name must contain only alphanumeric characters and hyphens" });
  }

  try {
    // Use the submitted custom name exactly as the API key
    const apiKey = customName;

    // Check if apiKey is already taken
    const existingKey = await usersCollection.findOne({ apiKey });
    if (existingKey) {
      return res.status(409).json({ status: "error", message: "API key already exists" });
    }

    // Calculate expiration date based on duration
    const expiresAt = new Date();
    let planType = "monthly";

    if (duration === "1 day") {
      expiresAt.setDate(expiresAt.getDate() + 1);
      planType = "daily";
    } else if (duration === "30 days") {
      expiresAt.setDate(expiresAt.getDate() + 30);
      planType = "monthly";
    } else {
      return res.status(400).json({ status: "error", message: "Duration must be '1 day' or '30 days'" });
    }

    // Store in database with email and customName
    await usersCollection.updateOne(
      { apiKey },
      { $set: { apiKey, email, customName, expiresAt, paymentStatus: "paid", planType } },
      { upsert: true }
    );

    return res.json({
      status: "ok",
      apiKey,
      email,
      customName,
      expiresAt,
      planType,
      message: `Custom key generated: ${apiKey}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: "Server error" });
  }
});

// ----------------------
// Yoco Checkout
// ----------------------
app.post("/api/yoco/checkout", async (req, res) => {
  const { token, amountInCents, email, idToken, duration } = req.body;
  if (!email || !idToken) return res.status(400).json({ status: "error", message: "Missing fields" });

  try {
    const payload = await verifyGoogleToken(idToken);
    if (payload.email !== email) return res.status(403).json({ status: "error", message: "Email mismatch" });

    const url = "https://online.yoco.com/v1/charges/";
    const headers = { "X-Auth-Secret-Key": YOCO_SECRET_KEY, "Content-Type": "application/json" };
    const body = { token, amountInCents, currency: "ZAR" };
    const response = await axios.post(url, body, { headers });

    if (response.data.status === "successful") {
      let apiKey = "bnh-" + crypto.randomBytes(3).toString("hex");
      const expiresAt = new Date();
      let planType = "monthly";
      if (duration === "daily") { expiresAt.setDate(expiresAt.getDate() + 1); planType="daily"; }
      else expiresAt.setDate(expiresAt.getDate() + 30);

      await usersCollection.updateOne(
        { email },
        { $set: { email, apiKey, expiresAt, paymentStatus: "paid", planType } },
        { upsert: true }
      );

      return res.json({ status: "ok", apiKey, expiresAt, planType, message: "Payment successful" });
    } else {
      return res.status(400).json({ status: "error", message: "Payment failed", data: response.data });
    }
  } catch (err) {
    console.error("Yoco error:", err.response?.data || err.message);
    return res.status(500).json({ status: "error", message: "Payment processing error" });
  }
});

// ----------------------
// Study Guide Upload
// ----------------------
app.post("/api/studyguide/upload", async (req, res) => {
  const { email, idToken, subject, fileData } = req.body;
  if (!email || !idToken || !subject || !fileData) return res.status(400).json({ status: "error", message: "Missing fields" });

  try {
    const payload = await verifyGoogleToken(idToken);
    if (payload.email !== email) return res.status(403).json({ status: "error", message: "Email mismatch" });

    const pdfBuffer = Buffer.from(fileData, "base64");
    const pdfData = await pdfParse(pdfBuffer, { max: 10 * 1024 * 1024 });
    const words = pdfData.text.split(/\s+/);
    const chunkSize = 500;
    const chunks = [];
    for (let i = 0; i < words.length; i += chunkSize) chunks.push(words.slice(i, i + chunkSize).join(" "));

    await db.collection("studyGuides").updateOne(
      { email, subject },
      { $set: { email, subject, chunks, uploadedAt: new Date(), chunkCount: chunks.length } },
      { upsert: true }
    );

    return res.json({ status: "ok", chunkCount: chunks.length, message: "Study guide uploaded" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: "Server error" });
  }
});
app.post("/api/heartbeat", async (req, res) => {
  const { apiKey, deviceId } = req.body;

  if (!apiKey || !deviceId)
    return res.status(400).json({ status: "error", message: "Missing fields" });

  try {
    const user = await usersCollection.findOne({ apiKey });
    if (!user) return res.status(403).json({ status: "error", message: "Invalid API key" });
    if (new Date(user.expiresAt) < new Date())
      return res.status(403).json({ status: "error", message: "API key expired" });

    await db.collection("activeKeys").updateOne(
      { apiKey, deviceId },
      { $set: { apiKey, deviceId, lastSeen: new Date() } },
      { upsert: true }
    );

    return res.json({ status: "ok", message: "Heartbeat updated" });

  } catch (err) {
    console.error("Heartbeat error:", err);
    res.status(500).json({ status: "error", message: "Server error" });
  }
});
app.get("/api/active-users", async (req, res) => {
  try {
    const TEN_MINUTES = 10 * 60 * 1000;
    const cutoff = new Date(Date.now() - TEN_MINUTES);

    const active = await db.collection("activeKeys")
      .find({ lastSeen: { $gte: cutoff } })
      .toArray();

    res.json({
      status: "ok",
      activeUsers: active.length
    });

  } catch (err) {
    console.error("Active users error:", err);
    res.status(500).json({ status: "error", message: "Server error" });
  }
});

app.get("/api/active-keys", async (req, res) => {
  try {
    const TEN_MINUTES = 10 * 60 * 1000;
    const cutoff = new Date(Date.now() - TEN_MINUTES);

    const active = await db.collection("activeKeys")
      .aggregate([
        { $match: { lastSeen: { $gte: cutoff } } },
        { $group: { _id: "$apiKey", devices: { $count: {} } } }
      ])
      .toArray();

    res.json({
      status: "ok",
      keys: active
    });

  } catch (err) {
    console.error("Active keys error:", err);
    res.status(500).json({ status: "error", message: "Server error" });
  }
});

const questionStructures = [];

  app.post("/api/question-structure", async (req, res) => {
    try {
      const { apiKey, metadata } = req.body || {};
      const questionStructure = metadata?.questionStructure;

      if (!apiKey || !questionStructure) {
        return res.status(400).json({ status: "error", message: "Missing data" });
      }

      questionStructures.push({
        apiKey,
        ...questionStructure,
        createdAt: new Date().toISOString()
      });

      return res.json({ status: "ok" });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ status: "error" });
    }
  });

  app.get("/api/question-structure", (req, res) => {
    res.json({
      status: "ok",
      count: questionStructures.length,
      items: questionStructures
    });
  });

  app.get("/api/question-structure/latest", (req, res) => {
    const latest = questionStructures[questionStructures.length - 1] || null;
    res.json({
      status: "ok",
      item: latest
    });
  });

app.post("/ideai", async (req, res) => {
  const { text, apiKey } = req.body;

  // -------------------------------
  // Basic validation
  // -------------------------------
  if (!text || typeof text !== "string") {
    return res.status(400).json({
      status: "error",
      message: "Missing or invalid text"
    });
  }

  try {
    // -------------------------------
    // Optional API key validation
    // -------------------------------
    if (apiKey) {
      const user = await usersCollection.findOne({ apiKey });

      if (!user) {
        return res.status(403).json({
          status: "error",
          message: "Invalid API key"
        });
      }

      if (new Date(user.expiresAt) < new Date()) {
        return res.status(403).json({
          status: "error",
          message: "API key expired"
        });
      }
    }

    // -------------------------------
    // AI providers
    // -------------------------------
    const aiAPIs = [
      {
        name: "copilot",
        url: "https://api.deline.web.id/ai/copilot"
      },
      {
        name: "copilot-think",
        url: "https://api.deline.web.id/ai/copilot-think"
      }
    ];

    const selected = aiAPIs[Math.floor(Math.random() * aiAPIs.length)];

    // -------------------------------
    // Call upstream AI (NO throw on 4xx/5xx)
    // -------------------------------
    let response;
    try {
      response = await axios.get(selected.url, {
        params: { text },
        timeout: 25000,
        validateStatus: () => true // critical
      });
    } catch (networkErr) {
      console.error("❌ Network error:", networkErr.message);

      return res.status(502).json({
        status: "error",
        message: "Upstream AI unreachable",
        source: selected.name
      });
    }

    // -------------------------------
    // Handle upstream failure
    // -------------------------------
    if (response.status !== 200) {
      console.error(
        "❌ Upstream AI error:",
        selected.name,
        response.status,
        response.data
      );

      return res.status(502).json({
        status: "error",
        message: "Upstream AI error",
        source: selected.name,
        upstreamStatus: response.status,
        upstreamBody: response.data
      });
    }

    // -------------------------------
    // Normalize AI response
    // -------------------------------
    const data = response.data || {};
    let outputText = "";

    if (typeof data.result === "string") {
      outputText = data.result;
    }
    else if (
      typeof data.result === "object" &&
      data.result !== null &&
      typeof data.result.text === "string"
    ) {
      outputText = data.result.text;
    }
    else if (data.status === true && typeof data.result === "string") {
      outputText = data.result;
    }
    else {
      outputText = JSON.stringify({
        thought: "AI returned unrecognized format",
        source: selected.name,
        raw: data
      });
    }

    // -------------------------------
    // Success
    // -------------------------------
    return res.json({
      status: "ok",
      result: {
        data: outputText
      }
    });

  } catch (err) {
    // -------------------------------
    // REAL server-side failure
    // -------------------------------
    console.error("❌ Internal server error:", err);

    return res.status(500).json({
      status: "error",
      message: "Internal server error"
    });
  }
});

app.post("/ai", async (req, res) => {
  let { text, apiKey, subject } = req.body;

  if (!text) {
    return res.status(400).json({ status: "error", message: "Missing text" });
  }

  try {
    // API key validation
    if (apiKey) {
      const user = await usersCollection.findOne({ apiKey });
      if (!user) return res.status(403).json({ status: "error", message: "Invalid API key" });
      if (new Date(user.expiresAt) < new Date()) return res.status(403).json({ status: "error", message: "API key expired" });
    }

    // Study guide extraction
    let studyGuideText = "";
    if (subject && apiKey) {
      const guide = await db.collection("studyGuides").findOne({ apiKey, subject });
      if (guide?.chunks?.length) {
        const tfidf = new natural.TfIdf();
        guide.chunks.forEach((chunk, i) => tfidf.addDocument(chunk.toLowerCase(), i.toString()));
        const similarities = guide.chunks.map((chunk, i) => ({
          chunk,
          score: tfidf.tfidf(text.toLowerCase(), i)
        }));
        similarities.sort((a, b) => b.score - a.score);
        const topChunks = similarities.slice(0, 3);
        studyGuideText = topChunks.map((item, i) => `Study Guide Part ${i + 1}:\n${item.chunk}`).join("\n\n");
      }
    }

    const systemPrompt = `
    Follow everything exactly how i say it!!
1. Remove all comments from code.
2. When generating code, only return the code, no comments.
3. Do not use formatting like astricts, bold, italics, or fancy symbols.
4. For math questions, avoid fancy symbols. Show steps without explanation.
5. Do not over explain with unnessesary answers, use simple english/terms , do not use dash , semi colon, eg, just answer the question.
6. if question says why , answer why, answer like a student from south africa.
${text}
`;

    const aiAPIs = [
      { name: "hanggts", url: "https://api.hanggts.xyz/ai/chatgpt4o", params: { text: systemPrompt } },
      { name: "okatsu", url: "https://okatsu-rolezapiiz.vercel.app/ai/chat", params: { text: systemPrompt } },
      { name: "cloudhostid", url: "https://api.cloudhostid.biz.id/ai/chatgpt", params: { query: systemPrompt } },
      { name: "ootaizumi", url: "https://api.ootaizumi.web.id/ai/ai-4-chat", params: { text: systemPrompt } },
      { name: "jerexd", url: "https://api.jerexd666.wongireng.my.id/ai/openai", params: { text: systemPrompt } },
      { name: "kyyokatsu", url: "https://kyyokatsurestapi.my.id/ai/gemini", params: { text: systemPrompt } },
      { name: "yupra", url: "https://api.yupra.my.id/api/ai/gpt5", params: { text: systemPrompt } },
      { name: "zell", url: "https://zellapi.autos/ai/chatbot", params: { text: systemPrompt } }
    ];

    const cleanText = (text) => {
      if (!text) return "";
      return text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
    };

    const callAPI = async (api) => {
      try {
        const response = await axios.get(api.url, { params: api.params, timeout: 15000 });
        return { name: api.name, data: response.data };
      } catch (err) {
        console.warn(`⚠️ [API Error]: ${api.url}, ${err.message}`);
        return null;
      }
    };

    const results = await Promise.all(aiAPIs.map(api => callAPI(api)));
    const validResults = results.filter(r => r && r.data);

    if (validResults.length === 0) {
      return res.status(500).json({ status: "error", message: "All AI API calls failed" });
    }

    const extractText = (name, data) => {
      try {
        if (!data) return `[${name}] returned no data`;

        // YuPra GPT-5
        if (name === "yupra" && data.status) return cleanText(data.result);

        // Zell API
        if (name === "zell" && data.status) return cleanText(data.result);

        // CloudHostID
        if (data?.result?.choices?.[0]?.message?.content) return cleanText(data.result.choices[0].message.content);

        // Ootaizumi
        if (typeof data.message === "string") return cleanText(data.message);

        // Jerexd
        if (data?.result?.response) return cleanText(data.result.response);

        // KyyOkatsu
        if (data?.result?.text) return cleanText(data.result.text);

        // Hanggts or fallback
        if (data?.result?.data) return cleanText(data.result.data);
        if (typeof data === "string") return cleanText(data);

        return `[${name}] could not parse response`;
      } catch {
        return `[${name}] could not parse response`;
      }
    };

    const allResponses = validResults.map(r => extractText(r.name, r.data)).filter(Boolean);
    const randomResponse = allResponses[Math.floor(Math.random() * allResponses.length)];

    res.json({
      status: "ok",
      result: { data: randomResponse, sources: validResults.map(r => r.name) }
    });

  } catch (err) {
    console.error("❌ [AI Proxy Error]:", err);
    res.status(500).json({ status: "error", message: "AI request failed" });
  }

}); // <-- end of app.post




app.post("/api/activate", async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ status: "error", message: "Missing key" });

  try {
    const user = await usersCollection.findOne({ apiKey: key });
    if (!user) return res.status(403).json({ status: "error", message: "Invalid key" });

    if (new Date(user.expiresAt) < new Date()) {
      return res.status(403).json({ status: "error", message: "Key expired" });
    }

    res.json({
      status: "ok",
      type: user.planType,
      expiry: user.expiresAt
    });
  } catch (err) {
    console.error("Activate key error:", err);
    res.status(500).json({ status: "error", message: "Server error" });
  }
});

app.post("/api/extension/upload", async (req, res) => {
  let { imageData, imageUrl, sentences } = req.body;

  console.log("📥 Received upload request");
  console.log("Sentences:", sentences);
  console.log("Image data present:", !!imageData);
  console.log("Image URL present:", !!imageUrl);

  if (!sentences || sentences.length === 0) {
    return res.status(400).json({ status: "error", message: "Missing sentences" });
  }

  try {
    const finalText = Array.isArray(sentences) ? sentences.join(" ") : sentences;
    const contents = [];

    // 1️⃣ If imageData exists, use it directly
    if (imageData) {
      contents.push({
        inlineData: {
          mimeType: "image/png",
          data: imageData
        }
      });
      console.log("📌 Using provided base64 image.");
    }

    // 2️⃣ If imageUrl exists but no imageData, try to fetch & convert to Base64
    else if (imageUrl) {
      try {
        const imageResp = await fetch(imageUrl);
        const arrayBuffer = await imageResp.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");

        contents.push({
          inlineData: {
            mimeType: "image/png",
            data: base64
          }
        });
        console.log("📌 Downloaded tmpfiles image and converted to Base64.");
      } catch (err) {
        console.warn("⚠ Failed to download/convert image URL, will fallback to fileUrl:", err);
        contents.push({ fileUrl: imageUrl });
      }
    }

    // 3️⃣ Always attach text content
    contents.push({ text: finalText });

    console.log(
      "📤 Sending to Gemini:",
      JSON.stringify({ model: "gemini-2.5-flash", contents }, null, 2)
    );

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents
    });

    console.log("✅ Gemini response received");
    res.json({ status: "ok", answer: response.text });

  } catch (err) {
    console.error("❌ Extension Gemini upload error:", err);
    console.error(
      "Payload that caused error:",
      JSON.stringify({ sentences, imageData: imageData?.slice?.(0, 100) + "...", imageUrl })
    );
    res.status(500).json({ status: "error", message: "Processing failed" });
  }
});

// ----------------------
// Humanizer Endpoints
// ----------------------
let latestHumanizedText = null;
let latestHumanizedOutput = null;
let humanizedHistory = [];

app.post("/humanize", (req,res)=>{ latestHumanizedText=req.body.text; res.json({status:"ok"}) });
app.get("/humanize/latest",(req,res)=>{ res.json({text:latestHumanizedText}) });
app.post("/humanize/output",(req,res)=>{ latestHumanizedOutput=req.body.text; humanizedHistory.push(req.body.text); res.json({status:"ok"}) });
app.get("/humanize/output",(req,res)=>{ res.json({text:latestHumanizedOutput}) });
app.get("/humanize/output/history",(req,res)=>{ res.json({history:humanizedHistory}) });

// ----------------------
// Searches Endpoint
// ----------------------
app.get("/api/searches", async (req,res)=>{
  const { apiKey } = req.query;
  if (!apiKey) return res.status(400).json({ status:"error", message:"Missing API key" });
  try {
    const user = await usersCollection.findOne({ apiKey });
    if (!user) return res.status(403).json({ status:"error", message:"Invalid API key" });
    if (new Date(user.expiresAt) < new Date()) return res.status(403).json({ status:"error", message:"API key expired" });

    const searches = await db.collection("searches").find({ email:user.email }).sort({timestamp:-1}).limit(20).toArray();
    res.json({ status:"ok", searches });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status:"error", message:"Server error" });
  }
});

// ----------------------
// Health Check
// ----------------------
app.get("/",(req,res)=>res.send("You are forbidden to be here!! Leave at once!!"));

// ----------------------
// Start Server
// ----------------------
const PORT = process.env.PORT || 3000;
async function startServer() {
  await connectDB();
  app.listen(PORT,()=>console.log(`🚀 ClipMind License Server running on port ${PORT}`));
}
startServer();
