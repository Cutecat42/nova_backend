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

// 1. Basic Health Check
app.get("/api/health", (req, res) => {
  res.json({
    status: "Nova Backend is online",
    root: process.env.PROJECT_ROOT,
  });
});

// 2. The Background-Capable Chat Route
app.post('/api/chat', async (req, res) => {
    const { session_id, ...ollamaPayload } = req.body;
    
    res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Transfer-Encoding': 'chunked'
    });

    let isAborted = false;
    req.on('aborted', () => {
        console.log(`⚠️ Client dropped early. Finishing in background...`);
        isAborted = true;
    });

    try {
        const ollamaRes = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ollamaPayload)
        });

        let fullReply = "";
        let streamBuffer = ""; 

        for await (const chunk of ollamaRes.body) {
            const chunkStr = chunk.toString();
            
            if (!isAborted) {
                res.write(chunkStr);
            }

            streamBuffer += chunkStr;
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop(); 

            for (const line of lines) {
                if (line.trim()) {
                    try { 
                        const parsed = JSON.parse(line);
                        if (parsed.message?.content) {
                            fullReply += parsed.message.content;
                        }
                    } catch (e) {} 
                }
            }
        }

        if (streamBuffer.trim()) {
            try { 
                const parsed = JSON.parse(streamBuffer);
                if (parsed.message?.content) fullReply += parsed.message.content;
            } catch (e) {}
        }
        
        if (!isAborted) {
            res.end();
        }

        if (session_id && fullReply) {
            console.log(`💾 Saving background reply...`);
            fetch(`${process.env.CLOUDFLARE_API_URL}/api/save-message`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id, role: "ai", content: fullReply.trim() })
            })
            .then(() => console.log("✅ D1 Save Complete!"))
            .catch(e => console.error("❌ D1 Save Failed:", e.message));
        }

    } catch (error) {
        console.error("Backend Chat Error:", error);
        if (!isAborted) {
            res.write(JSON.stringify({ error: error.message }));
            res.end();
        }
    }
});
app.listen(PORT, () => {
  console.log(`🚀 Nova Backend running on http://localhost:${PORT}`);
  console.log(`📂 Watching Project Root: ${process.env.PROJECT_ROOT}`);
});
