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


// GHL API Helper Headers
const ghlHeaders = {
    'Authorization': `Bearer ${GHL_API_TOKEN}`,
    'Version': '2021-07-28',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
};

// Fetch Contact Data from GHL
async function getContactData(contactId) {
    try {
        const url = `https://services.leadconnectorhq.com/contacts/${contactId}`;
        const response = await axios.get(url, { headers: ghlHeaders });
        const tags = response.data.contact.tags || [];
        const name = response.data.contact.firstName || "Customer";
        
        let tier = "Standard Customer";
        if (tags.includes("css managed customer")) tier = "Managed Success Customer";
        else if (tags.includes("css standard customer")) tier = "Standard Customer";
        
        return { name, tier, tags };
    } catch (e) {
        console.error("Failed to fetch contact data:", e.message);
        return { name: "Customer", tier: "Unknown Tier", tags: [] };
    }
}

// Add Tag to Contact in GHL
async function addContactTag(contactId, tag) {
    try {
        const url = `https://services.leadconnectorhq.com/contacts/${contactId}/tags`;
        await axios.post(url, { tags: [tag] }, { headers: ghlHeaders });
        console.log(`Successfully added tag '${tag}' to contact ${contactId}`);
    } catch (e) {
        console.error(`Failed to add tag '${tag}':`, e.message);
    }
}

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
        console.log(`Processing inbound message from Contact ${contactId} on channel ${channel}: ${userMessage}`);

        // Fetch Contact Tier Logic
        const contactData = await getContactData(contactId);

        // Ask the AI Brain (Gemini 3.1 Pro via OpenRouter)
        let aiResponseText = await getAiResponse(userMessage, contactData.name, contactData.tier);

        // Handover Logic Interception
        if (aiResponseText.includes("[HANDOVER]")) {
            console.log("ESCALATION TRIGGERED BY AI!");
            aiResponseText = aiResponseText.replace("[HANDOVER]", "").trim();
            // Send standard handover message if AI didn't provide one
            if (!aiResponseText) {
                aiResponseText = "I'll connect you with one of our support specialists who can take a closer look. They'll review your issue and reply shortly.";
            }
            // Add the handover tag in GHL
            await addContactTag(contactId, "css human handover");
        }
        
        // Send the AI's reply back to the GoHighLevel Conversation
        await sendGhlReply(locationId, conversationId, contactId, aiResponseText, channel);

    } catch (error) {
        console.error('Error processing webhook:', error.message);
    }
});

// Function to call OpenRouter API 
async function getAiResponse(userText, customerName, customerTier) {
    const systemPrompt = `You are Sona, the friendly and highly professional AI Customer Support Assistant for Aboova Digital Solutions.

Current Customer: ${customerName}
Customer Tier: ${customerTier}

Your Role & Tone:
Be extremely helpful, concise, and warm. Do not use markdown headers (# or ##) or mention internal technical titles.
Adapt your response slightly based on the Customer Tier:
- If "Standard Customer": Emphasize self-service help and tutorials.
- If "Managed Success Customer": Provide "White-glove" conversational responses and reassure them their dedicated manager is monitoring the account.

HUMAN HANDOVER RULES:
If the user asks for a human, or if you cannot find the answer in the Knowledge Base to resolve their issue, you MUST append the exact word [HANDOVER] to the very end of your response. 
Reassure them you are connecting them to a human specialist.

Here is the Aboova Knowledge Base containing all specific steps, video links, and tips:
${cachedKnowledgeBase}

CRITICAL RULES:
1. If the user's request matches an article, provide the steps cleanly using numbered lists or bullet points without massive spacing. Keep formatting looking like a clean professional text.
2. You MUST always include the "Video Tutorial" link and the "Pro Tip" from the article exactly as they are written at the end of your response.
3. If no article exists, default to your general knowledge about Aboova's AI SaaS tools, but do NOT make up fake video links.`;

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
