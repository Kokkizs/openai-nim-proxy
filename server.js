const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

app.get('/', (req, res) => res.send('NVIDIA Proxy: Flattener Active'));

app.post('/v1/chat/completions', async (req, res) => {
    try {
        const rawModel = req.body.model || '';
        
        // 1. UI TRICK: Strip "-thinking" from the name
        // We do this so NVIDIA gets the real name, but Janitor thinks it's a "thinking" model.
        const actualModel = rawModel.replace('-thinking', '');
        const modelLower = actualModel.toLowerCase();

        // 2. CONSTRUCT CLEAN PAYLOAD (Moving chat_template_kwargs to the root)
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

        // 3. INJECT FLAGS (Directly into the root, NOT inside extra_body)
        if (modelLower.includes('glm')) {
            cleanPayload.chat_template_kwargs = { 
                enable_thinking: true, 
                clear_thinking: false 
            };
        } else if (modelLower.includes('deepseek-v4') || (modelLower.includes('kimi-k2') && !modelLower.includes('thinking'))) {
            cleanPayload.chat_template_kwargs = { 
                thinking: true 
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
        if (error.response) {
            console.error("NVIDIA Error:", error.response.status);
            // This prints the actual reason from NVIDIA to your Leapcell logs
            error.response.data.on('data', (chunk) => console.error("API Detail:", chunk.toString()));
        } else {
            console.error("Proxy Error:", error.message);
        }
        res.status(500).json({ error: { message: "NVIDIA API Error" } });
    }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
