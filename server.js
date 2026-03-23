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

    // 2. Extract Data from GHL Workflow Payload
    const data = req.body;
    
    // Read the nested message body
    let userMessage = "";
    if (data.message && data.message.body) {
        userMessage = data.message.body;
    } else {
        userMessage = data.message || data.body;
    }

    const contactId = data.contact_id;
    // Workflows don't always pass conversation_id, but the V2 API can use contactId to find it!
    const conversationId = data.conversation_id || ""; 
    const locationId = (data.location && data.location.id) ? data.location.id : (data.location_id || data.locationId);
    const channel = "Email"; // Email type handles Widget routing best

    // Safety check
    if (!userMessage || !contactId) {
        console.log("Missing message or contact ID. Payload:", JSON.stringify(data, null, 2));
        return;
    }

    try {
        console.log(`Processing inbound message from Contact ${contactId}: ${userMessage}`);

        // 3. Ask the AI Brain (Gemini 3.1 Pro via OpenRouter) what to say
        const aiResponseText = await getAiResponse(userMessage);
        
        // 4. Send the AI's reply back to the GoHighLevel Conversation!
        await sendGhlReply(locationId, conversationId, contactId, aiResponseText, channel);

    } catch (error) {
        console.error('Error processing webhook:', error.response ? error.response.data : error.message);
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
    
    const payload = {
        locationId: locationId,
        type: channel, 
        message: messageText,
        contactId: contactId
    };

    // Only attach conversationId if it was provided
    if (conversationId) {
        payload.conversationId = conversationId;
    }

    const headers = {
        'Authorization': `Bearer ${GHL_API_TOKEN}`,
        'Version': '2021-04-15',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };

    await axios.post(url, payload, { headers });
    console.log(`Reply successfully sent to Contact ID: ${contactId}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Aboova AI Webhook Server is running on port ${PORT}`);
});
