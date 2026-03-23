require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const GHL_API_TOKEN = process.env.GHL_API_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

app.post('/webhook', async (req, res) => {
    // 1. Immediately acknowledge the webhook to GoHighLevel (prevents timeout)
    res.status(200).send({ message: 'Webhook received' });

    // 2. Extract Data from GHL Payload
    const data = req.body;
    const userMessage = data.message || data.body; 
    const contactId = data.contact_id;
    const conversationId = data.conversation_id;
    const locationId = data.location_id || data.locationId;
    const channel = data.type || "email"; 

    // Safety checks
    if (!userMessage || !conversationId) {
        console.log("Missing message or conversation ID. Payload:", data);
        return;
    }

    try {
        console.log(`Processing inbound message from ${contactId}: ${userMessage}`);

        // 3. Ask the AI Brain (Gemini 3.1 Pro via OpenRouter) what to say
        const aiResponseText = await getAiResponse(userMessage);
        
        // 4. Send the AI's reply back to the GoHighLevel Conversation!
        await sendGhlReply(locationId, conversationId, contactId, aiResponseText, channel);

    } catch (error) {
        console.error('Error processing webhook:', error);
    }
});

// Function to call OpenRouter API 
async function getAiResponse(userText) {
    const systemPrompt = `You are Aria, the AI Customer Support Agent and CSM Copilot for Aboova Digital Solutions. 
Be concise, highly professional, and extremely helpful. Do not use markdown headers or special formatting in the chat widget.
Respond directly to the user's inquiry based on Aboova's capabilities (AI Growth Engine, Digital Marketing, Web Development, SaaS Tools).`;

    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: "google/gemini-3.1-pro-preview-customtools",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userText }
        ]
    }, {
        headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://aboova.com',
            'X-Title': 'Aboova AI Widget',
            'Content-Type': 'application/json'
        }
    });

    return response.data.choices[0].message.content;
}

// Function to Reply back via GHL API (V2)
async function sendGhlReply(locationId, conversationId, contactId, messageText, channel) {
    const url = 'https://services.leadconnectorhq.com/conversations/messages';
    
    // GHL allows sending to 'Widget' (Live Chat) as 'email' or 'sms' depending on config. "Email" handles widget well.
    const payload = {
        locationId: locationId,
        type: "Email", 
        message: messageText,
        conversationId: conversationId,
        contactId: contactId
    };

    const headers = {
        'Authorization': `Bearer ${GHL_API_TOKEN}`,
        'Version': '2021-04-15',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };

    await axios.post(url, payload, { headers });
    console.log(`Reply successfully sent to Conversation ID: ${conversationId}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Aboova AI Webhook Server is running on port ${PORT}`);
});
