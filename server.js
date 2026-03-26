require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const GHL_API_TOKEN = process.env.GHL_API_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;

// ---------------------------------------------------------
// PORTFOLIO CONFIGURATION (Used for the /assign webhook)
// ---------------------------------------------------------
const PORTFOLIOS = [
    { name: "California", tag: "css portfolio | California", userId: "iB9bqEHShZWespVRwwNa" },
    { name: "Colorado", tag: "css portfolio | Colorado", userId: "dFuqKypWMpfvAfg6pHhg" },
    { name: "Connecticut", tag: "css portfolio | Connecticut", userId: "6q5FEvL51cOoSo1Vwlce" },
    { name: "Delaware", tag: "css portfolio | Delaware", userId: "5Tjye3dUlKl99sPlSObF" }
];

// The exact ID of the "Aboova Support Knowledge Base" folder
const KNOWLEDGE_BASE_FOLDER_ID = '1Dm5-z-EDZogu6GcufAYrzctlbWTioiSr';
let cachedKnowledgeBase = "";

// GHL API Helper Headers
const ghlHeaders = {
    'Authorization': `Bearer ${GHL_API_TOKEN}`,
    'Version': '2021-07-28',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
};

// Authenticate with Google Drive & Load Knowledge Base
async function loadKnowledgeBase() {
    console.log("Loading Knowledge Base from Google Drive...");
    try {
        const credentials = JSON.parse(GOOGLE_CREDENTIALS);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/documents.readonly'],
        });
        const drive = google.drive({ version: 'v3', auth });
        const docs = google.docs({ version: 'v1', auth });

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
                            if (e.textRun && e.textRun.content) docText += e.textRun.content;
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
loadKnowledgeBase();

// Fetch Contact Data from GHL
async function getContactData(contactId) {
    try {
        const url = `https://services.leadconnectorhq.com/contacts/${contactId}`;
        const response = await axios.get(url, { headers: ghlHeaders });
        const tags = response.data.contact.tags || [];
        const name = response.data.contact.firstName || "Customer";
        
        let tier = "Standard Customer";
        if (tags.includes("css plan | managed success")) tier = "Managed Success Customer";
        else if (tags.includes("css plan | standard support")) tier = "Standard Customer";
        
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

// ---------------------------------------------------------
// WEBHOOK 1: ONBOARDING ASSIGNMENT (LOAD BALANCING)
// ---------------------------------------------------------
app.post('/assign', async (req, res) => {
    res.status(200).send({ message: 'Assignment webhook received' });

    const contactId = req.body.contact_id || req.body.contactId;
    const locationId = req.body.location_id || req.body.locationId;
    if (!contactId || !locationId) return;

    try {
        console.log(`Starting Portfolio assignment for contact ${contactId}...`);
        
        // Count how many contacts each Portfolio has using GHL Search API
        let portfolioCounts = [];
        for (const portfolio of PORTFOLIOS) {
            try {
                const response = await axios.post('https://services.leadconnectorhq.com/contacts/search', 
                    { locationId: locationId, filters: [{ field: "tag", operator: "eq", value: portfolio.tag }] }, 
                    { headers: ghlHeaders }
                );
                const count = response.data.meta?.total || response.data.contacts?.length || 0;
                portfolioCounts.push({ ...portfolio, count });
            } catch (e) {
                console.log(`Failed to fetch count for ${portfolio.name}, defaulting to 0`);
                portfolioCounts.push({ ...portfolio, count: 0 });
            }
        }

        // Sort Portfolios by count (lowest first)
        portfolioCounts.sort((a, b) => a.count - b.count);
        const winningPortfolio = portfolioCounts[0];

        console.log(`Assigning contact to ${winningPortfolio.name} (Current load: ${winningPortfolio.count} clients)`);

        // Update the Contact in GHL (Add the Tag AND Assign the User)
        const updateUrl = `https://services.leadconnectorhq.com/contacts/${contactId}`;
        const payload = {
            assignedTo: [winningPortfolio.userId],
            tags: [winningPortfolio.tag]
        };

        await axios.put(updateUrl, payload, { headers: ghlHeaders });
        console.log(`Successfully assigned ${contactId} to ${winningPortfolio.name}!`);

    } catch (error) {
        console.error("Error during Portfolio Assignment:", error.message);
    }
});

// ---------------------------------------------------------
// WEBHOOK 2: CHAT SUPPORT (SONA)
// ---------------------------------------------------------
app.post('/webhook', async (req, res) => {
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

    if (!userMessage || !contactId) return;

    try {
        const contactData = await getContactData(contactId);
        let aiResponseText = await getAiResponse(userMessage, contactData.name, contactData.tier);
        
        if (aiResponseText.includes("[HANDOVER]")) {
            console.log("ESCALATION TRIGGERED BY AI!");
            aiResponseText = aiResponseText.replace("[HANDOVER]", "").trim();
            if (!aiResponseText) {
                aiResponseText = "I'll connect you with our support specialists who can take a closer look. They'll review your issue and reply shortly.";
            }
            await addContactTag(contactId, "css human handover");
        }
        
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
Be conversational, warm, and extremely helpful. Do not use markdown headers in the chat widget. Do not mention internal titles.
Adapt your response based on the Customer Tier:
- If "Standard Customer": Emphasize self-service help and tutorials.
- If "Managed Success Customer": Provide "White-glove" concierge responses and reassure them you are working alongside their dedicated manager.

Here is the Aboova Knowledge Base containing specific steps, video links, and tips:
${cachedKnowledgeBase}

CRITICAL RULES: 
1. If the user's request matches an article in the Knowledge Base, provide the steps cleanly using numbered lists or bullet points. Do not be overly wordy and avoid excessive line breaks or huge spacing. Present the information as a clean, highly professional chat message.
2. You MUST always include the "Video Tutorial" link and the "Pro Tip" from the article exactly as they are written at the end of your response. Do not use markdown headers (# or ##).
3. If the Knowledge Base does not cover the topic, default to your general knowledge about Aboova's AI SaaS tools and marketing services.

HUMAN HANDOVER RULES:
If the user asks for a human, or if you cannot find the answer in the Knowledge Base to resolve their issue, you MUST append the exact word [HANDOVER] to the very end of your response. 
Reassure them you are connecting them to a human specialist.`;

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
