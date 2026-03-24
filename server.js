require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const GHL_API_TOKEN = process.env.GHL_API_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;

// The exact ID of the "Aboova Support Knowledge Base" folder
const KNOWLEDGE_BASE_FOLDER_ID = '1Dm5-z-EDZogu6GcufAYrzctlbWTioiSr';

let cachedKnowledgeBase = "";

// Authenticate with Google Drive
async function getDriveAuth() {
    try {
        const credentials = JSON.parse(GOOGLE_CREDENTIALS);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/documents.readonly'],
        });
        return auth;
    } catch (error) {
        console.error('Error parsing GOOGLE_CREDENTIALS. Make sure the JSON is valid!', error);
        return null;
    }
}

// Read Docs from the Knowledge Base Folder
async function loadKnowledgeBase() {
    console.log("Loading Knowledge Base from Google Drive...");
    const auth = await getDriveAuth();
    if (!auth) return;

    const drive = google.drive({ version: 'v3', auth });
    const docs = google.docs({ version: 'v1', auth });

    try {
        const res = await drive.files.list({
            q: `'${KNOWLEDGE_BASE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
            fields: 'files(id, name)',
        });

        let allContent = "ABOOVA KNOWLEDGE BASE ARTICLES:\\n\\n";
        
        for (const file of res.data.files) {
            console.log(`Reading Article: ${file.name}`);
            const doc = await docs.documents.get({ documentId: file.id });
            
            let docText = `--- Article: ${file.name} ---\\n`;
            if (doc.data.body && doc.data.body.content) {
                doc.data.body.content.forEach(p => {
                    if (p.paragraph && p.paragraph.elements) {
                        p.paragraph.elements.forEach(e => {
                            if (e.textRun && e.textRun.content) {
                                docText += e.textRun.content;
                            }
                        });
                    }
                });
            }
            allContent += docText + "\\n\\n";
        }
        
        cachedKnowledgeBase = allContent;
        console.log("Knowledge Base successfully loaded into memory!");
        
    } catch (error) {
        console.error('Error reading Google Drive:', error.message);
    }
}

// Load the Knowledge Base when the server starts
loadKnowledgeBase();

app.post('/webhook', async (req, res) => {
    // 1. Immediately acknowledge the webhook
    res.status(200).send({ message: 'Webhook received' });

    const data = req.body;
    let userMessage = "";
    if (data.message && data.message.body) {
        userMessage = data.message.body;
    } else {
        userMessage = data.message || data.body;
    }

    const contactId = data.contact_id || data.contactId;
    const conversationId = data.conversation_id || data.conversationId || ""; 
    const locationId = (data.location && data.location.id) ? data.location.id : (data.location_id || data.locationId);
    
    let channel = data.type || "Live_Chat";
    if (channel.toLowerCase() === 'widget' || channel.toLowerCase() === 'live_chat') {
        channel = "Live_Chat"; 
    } else if (channel.toLowerCase() === 'sms') {
        channel = "SMS";
    }

    if (!userMessage || !contactId) {
        console.log("Missing message or contact ID.");
        return;
    }

    try {
        console.log(`Processing inbound message: ${userMessage}`);
        const aiResponseText = await getAiResponse(userMessage);
        await sendGhlReply(locationId, conversationId, contactId, aiResponseText, channel);
    } catch (error) {
        console.error('Error processing webhook:', error.message);
    }
});

// Function to call OpenRouter API 
async function getAiResponse(userText) {
    const systemPrompt = `You are Sona, the friendly and highly professional AI Customer Support Assistant for Aboova Digital Solutions.
Be concise, warm, and extremely helpful. Do not use markdown headers in the chat widget. Do not mention internal titles.

Here is the Aboova Knowledge Base containing exact steps and video links:
${cachedKnowledgeBase}

CRITICAL RULE: If the user's request matches an article in the Knowledge Base, you MUST provide the exact steps from the article, and you MUST include the "Video Tutorial" link and the "Pro Tip" exactly as they are written in the document. Do not summarize them into general steps. 
If the Knowledge Base does not cover the topic, default to your general knowledge.`;

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
    console.log(`Reply successfully sent to Contact ID: ${contactId} via ${channel}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Aboova AI Webhook Server is running on port ${PORT}`);
});
