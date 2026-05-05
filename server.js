const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

app.get('/', (req, res) => res.send('NVIDIA Thinking Proxy Active'));

app.post('/v1/chat/completions', async (req, res) => {
    try {
        const rawModel = req.body.model || '';
        
        // 1. STRIP THE UI TRIGGER
        // This lets you use "z-ai/glm4.7-thinking" in JanitorAI to force the box open
        const actualModel = rawModel.replace('-thinking', '');
        const modelLower = actualModel.toLowerCase();

        // 2. CLEAN PAYLOAD (The 500 Error Fix)
        // We ONLY send parameters NVIDIA's thinking-mode parser accepts.
        // We drop top_k, presence_penalty, etc. which cause the 500 error.
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

        // 3. INJECT THINKING FLAGS
        if (modelLower.includes('glm')) {
            cleanPayload.extra_body = {
                chat_template_kwargs: { enable_thinking: true, clear_thinking: false }
            };
        } else if (modelLower.includes('deepseek-v4') || (modelLower.includes('kimi-k2') && !modelLower.includes('thinking'))) {
            // Only add flags for base Kimi; 'kimi-k2-thinking' handles it natively
            cleanPayload.extra_body = {
                chat_template_kwargs: { thinking: true }
            };
        }

        const response = await axios.post(`${NIM_API_BASE}/chat/completions`, cleanPayload, {
            headers: {
                'Authorization': `Bearer ${NIM_API_KEY}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        });

        res.setHeader('Content-Type', 'text/event-stream');
        response.data.pipe(res);

    } catch (error) {
        // Detailed error logging for Leapcell console
        if (error.response) {
            console.error("NVIDIA Rejected Request:", error.response.status);
            error.response.data.on('data', (chunk) => console.error("Error Detail:", chunk.toString()));
        } else {
            console.error("Proxy Error:", error.message);
        }
        res.status(500).json({ error: { message: "NVIDIA API Error - Check Proxy Logs" } });
    }
});

app.listen(PORT, () => console.log(`Fixed Proxy on port ${PORT}`));
