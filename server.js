const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Health check restored
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'NVIDIA Proxy' }));
app.get('/', (req, res) => res.send('Proxy is running.'));

app.post('/v1/chat/completions', async (req, res) => {
    try {
        const payload = { ...req.body, stream: true };
        const modelName = (payload.model || '').toLowerCase();

        // Inject the required flags to force models to output 'reasoning_content'
        if (modelName.includes('glm')) {
            // Fix: Put chat_template_kwargs BACK inside extra_body as required by NVIDIA
            payload.extra_body = {
                chat_template_kwargs: { enable_thinking: true, clear_thinking: false }
            };
        } else if (modelName.includes('deepseek-v4') || modelName.includes('kimi-k2.6')) {
            payload.extra_body = {
                chat_template_kwargs: { thinking: true }
            };
        }
        // Note: 'kimi-k2-thinking' doesn't need extra_body flags, it thinks natively!

        const response = await axios.post(`${NIM_API_BASE}/chat/completions`, payload, {
            headers: {
                'Authorization': `Bearer ${NIM_API_KEY}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Pure Pass-Through! 
        // JanitorAI natively reads reasoning_content, so we just pipe NVIDIA's stream directly to it.
        response.data.pipe(res);

    } catch (error) {
        console.error("Proxy error:", error.response?.data || error.message);
        res.status(500).json({ error: { message: "Proxy error" } });
    }
});

app.listen(PORT, () => console.log(`Minimalist NVIDIA Proxy running on port ${PORT}`));
