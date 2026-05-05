const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

app.get('/', (req, res) => res.send('NVIDIA Proxy: Full Stream Active'));

app.post('/v1/chat/completions', async (req, res) => {
    try {
        const rawModel = req.body.model || '';
        const actualModel = rawModel.replace('-thinking', '');
        const modelLower = actualModel.toLowerCase();

        // 1. Clean Payload - Required to avoid NVIDIA 400/500 errors
        const cleanPayload = {
            model: actualModel,
            messages: req.body.messages.map(m => ({
                role: m.role === 'developer' ? 'system' : m.role,
                content: m.content
            })),
            temperature: req.body.temperature ?? 1,
            top_p: req.body.top_p ?? 1,
            max_tokens: req.body.max_tokens || 4096,
            stream: true
        };

        // 2. Inject Thinking Flags
        if (modelLower.includes('glm')) {
            cleanPayload.chat_template_kwargs = { enable_thinking: true, clear_thinking: false };
        } else if (modelLower.includes('deepseek-v4') || (modelLower.includes('kimi-k2') && !modelLower.includes('thinking'))) {
            cleanPayload.chat_template_kwargs = { thinking: true };
        }

        const response = await axios.post(`${NIM_API_BASE}/chat/completions`, cleanPayload, {
            headers: {
                'Authorization': `Bearer ${NIM_API_KEY}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        });

        // 3. CRITICAL: Leapcell/Janitor Streaming Headers
        // This bypasses the 5MB limit by sending data in tiny chunks
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); 

        // 4. The Heartbeat (Prevents Leapcell from timing out during long thinking)
        const heartbeat = setInterval(() => {
            res.write(': heartbeat\n\n');
        }, 15000);

        response.data.on('data', (chunk) => {
            res.write(chunk);
        });

        response.data.on('end', () => {
            clearInterval(heartbeat);
            res.end();
        });

        response.data.on('error', () => {
            clearInterval(heartbeat);
            res.end();
        });

    } catch (error) {
        if (error.response) {
            error.response.data.on('data', (chunk) => console.error("NVIDIA Error:", chunk.toString()));
        } else {
            console.error("Proxy Error:", error.message);
        }
        res.status(500).json({ error: { message: "NVIDIA API Error" } });
    }
});

app.listen(PORT, () => console.log(`Proxy active on port ${PORT}`));
