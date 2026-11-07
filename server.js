
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const OLLAMA_URL = process.env.OLLAMA_URL;
const NOVA_BACKEND_SECRET = process.env.NOVA_BACKEND_SECRET;
const CLOUDFLARE_API_URL = process.env.CLOUDFLARE_API_URL;

// ==========================================
// BACKEND AUTHENTICATION
// ==========================================

const authenticateBackend = (req, res, next) => {
  const providedSecret = req.headers["x-nova-secret"];

  if (
    !NOVA_BACKEND_SECRET ||
    providedSecret !== NOVA_BACKEND_SECRET
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

// ==========================================
// CONFIGURATION CHECK
// ==========================================

const checkOllamaConfig = (req, res, next) => {
  if (!OLLAMA_URL) {
    return res.status(500).json({
      error: "OLLAMA_URL is not configured",
    });
  }

  next();
};

// ==========================================
// 1. HEALTH CHECK
// ==========================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "Nova Backend is online",
  });
});

// ==========================================
// 2. OLLAMA MODEL LIST
// ==========================================

app.get(
  "/api/tags",
  authenticateBackend,
  checkOllamaConfig,
  async (req, res) => {
    try {
      const ollamaRes = await fetch(
        `${OLLAMA_URL.replace(/\/+$/, "")}/api/tags`
      );

      const responseText = await ollamaRes.text();

      res.status(ollamaRes.status);

      res.type(
        ollamaRes.headers.get("content-type") ||
        "application/json"
      );

      res.send(responseText);

    } catch (error) {
      console.error("Ollama Tags Error:", error);

      res.status(502).json({
        error: "Could not connect to Ollama",
      });
    }
  }
);

// ==========================================
// 3. OLLAMA EMBEDDINGS
// ==========================================

app.post(
  "/api/embed",
  authenticateBackend,
  checkOllamaConfig,
  async (req, res) => {
    try {
      const ollamaRes = await fetch(
        `${OLLAMA_URL.replace(/\/+$/, "")}/api/embed`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(req.body),
        }
      );

      const responseText = await ollamaRes.text();

      res.status(ollamaRes.status);

      res.type(
        ollamaRes.headers.get("content-type") ||
        "application/json"
      );

      res.send(responseText);

    } catch (error) {
      console.error("Ollama Embedding Error:", error);

      res.status(502).json({
        error: "Could not generate embeddings",
      });
    }
  }
);

// ==========================================
// 4. CHAT
// ==========================================

app.post(
  "/api/chat",
  authenticateBackend,
  checkOllamaConfig,
  async (req, res) => {
    const requestStarted = Date.now();

    const { session_id, ...ollamaPayload } = req.body;

    console.log("\n----------------------------------------");
    console.log("📨 NEW CHAT REQUEST");
    console.log(
      "⏱️ Backend received request:",
      new Date().toLocaleTimeString()
    );

    let clientDisconnected = false;

    res.on("close", () => {
      if (!res.writableEnded) {
        clientDisconnected = true;

        console.log(
          "⚠️ Client disconnected. Finishing generation in background..."
        );
      }
    });

    try {
      console.log("⏳ Sending request to Ollama...");

      const ollamaRes = await fetch(
        `${OLLAMA_URL.replace(/\/+$/, "")}/api/chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(ollamaPayload),
        }
      );

      console.log(
        `📡 Ollama response headers received: ${
          Date.now() - requestStarted
        } ms`
      );

      console.log(
        "📡 Ollama HTTP status:",
        ollamaRes.status
      );

      if (!ollamaRes.ok) {
        const errorText = await ollamaRes.text();

        throw new Error(
          `Ollama HTTP ${ollamaRes.status}: ${errorText}`
        );
      }

      if (!clientDisconnected) {
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Transfer-Encoding": "chunked",
          "Cache-Control": "no-cache",
        });
      }

      let fullReply = "";
      let streamBuffer = "";
      let ollamaFinal = null;

      let firstChunkLogged = false;
      let firstContentLogged = false;

      // ======================================
      // READ OLLAMA STREAM
      // ======================================

      for await (const chunk of ollamaRes.body) {
        const now = Date.now();
        const chunkStr = chunk.toString();

        if (!firstChunkLogged) {
          firstChunkLogged = true;

          console.log(
            `📦 FIRST OLLAMA CHUNK: ${
              now - requestStarted
            } ms`
          );
        }

        if (!clientDisconnected) {
          res.write(chunkStr);
        }

        streamBuffer += chunkStr;

        const lines = streamBuffer.split("\n");

        streamBuffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line);

            if (parsed.done) {
              ollamaFinal = parsed;
            }

            if (parsed.message?.content) {
              if (!firstContentLogged) {
                firstContentLogged = true;

                console.log(
                  `📝 FIRST ACTUAL WORD CONTENT: ${
                    Date.now() - requestStarted
                  } ms`
                );
              }

              fullReply += parsed.message.content;
            }

          } catch (error) {
            console.error(
              "Stream parsing warning:",
              error.message
            );
          }
        }
      }

      if (streamBuffer.trim()) {
        try {
          const parsed = JSON.parse(streamBuffer);

          if (parsed.done) {
            ollamaFinal = parsed;
          }

          if (parsed.message?.content) {
            if (!firstContentLogged) {
              firstContentLogged = true;

              console.log(
                `📝 FIRST ACTUAL WORD CONTENT: ${
                  Date.now() - requestStarted
                } ms`
              );
            }

            fullReply += parsed.message.content;
          }

        } catch (error) {
          console.error(
            "Final stream parsing warning:",
            error.message
          );
        }
      }

      console.log(
        `🏁 OLLAMA STREAM FINISHED: ${
          Date.now() - requestStarted
        } ms`
      );

      // ======================================
      // OLLAMA PERFORMANCE BREAKDOWN
      // ======================================

      if (ollamaFinal) {
        const seconds = (ns) =>
          ns == null
            ? "not reported"
            : `${(ns / 1e9).toFixed(2)} sec`;

        console.log("📊 OLLAMA PERFORMANCE BREAKDOWN");
        console.log("Model:", ollamaPayload.model);
        console.log(
          "Load duration:",
          seconds(ollamaFinal.load_duration)
        );
        console.log(
          "Prompt evaluation:",
          seconds(ollamaFinal.prompt_eval_duration)
        );
        console.log(
          "Generation:",
          seconds(ollamaFinal.eval_duration)
        );
        console.log(
          "Total Ollama duration:",
          seconds(ollamaFinal.total_duration)
        );
        console.log(
          "Prompt tokens:",
          ollamaFinal.prompt_eval_count
        );
        console.log(
          "Generated tokens:",
          ollamaFinal.eval_count
        );
      }

      // ======================================
      // SAVE COMPLETED ASSISTANT MESSAGE
      // ======================================

      if (session_id && fullReply.trim()) {
        console.log("💾 Saving completed assistant reply...");

        try {
          if (!CLOUDFLARE_API_URL) {
            throw new Error(
              "CLOUDFLARE_API_URL is not configured"
            );
          }

          const saveRes = await fetch(
            `${CLOUDFLARE_API_URL.replace(/\/+$/, "")}/api/save-message`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-nova-secret": NOVA_BACKEND_SECRET,
              },
              body: JSON.stringify({
                session_id,
                role: "ai",
                content: fullReply.trim(),
              }),
            }
          );

          if (!saveRes.ok) {
            const errorText = await saveRes.text();

            throw new Error(
              `Cloudflare save failed (${saveRes.status}): ${errorText}`
            );
          }

          console.log("✅ D1 Assistant Message Saved!");

        } catch (error) {
          console.error(
            "❌ D1 Assistant Message Save Failed:",
            error.message
          );
        }
      }

      if (!clientDisconnected && !res.writableEnded) {
        res.end();
      }

      console.log("----------------------------------------\n");

    } catch (error) {
      console.error("❌ Backend Chat Error:", error);

      console.log(
        `⏱️ Failed after: ${
          Date.now() - requestStarted
        } ms`
      );

      if (!res.headersSent && !clientDisconnected) {
        res.status(502).json({
          error: error.message,
        });
      } else if (!clientDisconnected && !res.writableEnded) {
        res.end();
      }
    }
  }
);

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, () => {
  console.log(
    `🚀 Nova Backend running on http://localhost:${PORT}`
  );

  console.log(
    `📂 Watching Project Root: ${process.env.PROJECT_ROOT}`
  );
});
