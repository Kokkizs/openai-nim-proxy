const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY; // Ensure this is set in your Leapcell environment

app.get('/health', (req, res) => res.status(200).send('OK'));

app.post('/v1/chat/completions', async (req, res) => {
    try {
        const rawModelName = req.body.model || '';
        
        // --- FIX 1: THE JANITOR UI FIX ---
        // Strip "-thinking" so NVIDIA gets the real name, but Janitor still triggers the UI.
        const actualModelName = rawModelName.replace('-thinking', '');
        const modelLower = actualModelName.toLowerCase();

        // --- FIX 2: THE 500 ERROR FIX ---
        // We map Janitor's 'developer' role back to 'system' to prevent NVIDIA from crashing.
        // We also only pass strictly required parameters to avoid validation errors.
        const payload = {
            model: actualModelName,
            stream: true,
            temperature: req.body.temperature,
            top_p: req.body.top_p,
            max_tokens: Math.min(req.body.max_tokens || 4096, 4096),
            messages: req.body.messages.map(msg => ({
                role: msg.role === 'developer' ? 'system' : msg.role,
                content: msg.content
            }))
        };

        // --- FIX 3: THE NVIDIA THINKING PARAMS ---
        if (modelLower.includes('glm')) {
            payload.extra_body = {
                chat_template_kwargs: { enable_thinking: true, clear_thinking: false }
            };
        } else if (modelLower.includes('deepseek') || modelLower.includes('kimi-k2.6')) {
            payload.extra_body = {
                chat_template_kwargs: { thinking: true }
            };
        }

        // Send to NVIDIA
        const response = await axios.post(`${NIM_API_BASE}/chat/completions`, payload, {
            headers: {
                'Authorization': `Bearer ${NIM_API_KEY}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        });

        // Pass headers for Server-Sent Events
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Pure pass-through back to JanitorAI
        response.data.pipe(res);

    } catch (error) {
        console.error("API Error encountered");
        if (error.response && error.response.data) {
            // Log the actual NVIDIA error stream to Leapcell console
            error.response.data.on('data', chunk => console.error(chunk.toString()));
        } else {
            console.error(error.message);
        }
        res.status(500).json({ error: { message: "Proxy error" } });
    }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
