const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const GHL_API_TOKEN = process.env.GHL_API_TOKEN;

app.post('/ghl-webhook', async (req, res) => {
    res.status(200).send('Webhook received');

    try {
        // Extract the data in the exact format GHL Workflows send it
        const contactId = req.body.contact_id || req.body.id;
        const msg = req.body.message || {};
        const userMessage = msg.body;

        if (!userMessage) {
            console.log('No message body found, ignoring.');
            return;
        }

        console.log("New message from contact " + contactId + ": " + userMessage);

        const botReply = "Hi! I'm Aria, Aboova's digital assistant. I received your message: " + userMessage + ". How can I help you grow today?";

        await sendReplyToGHL(contactId, botReply);

    } catch (error) {
        console.error('Error processing webhook:', error.message);
    }
});

async function sendReplyToGHL(contactId, text) {
    try {
        await axios.post(
            'https://services.leadconnectorhq.com/conversations/messages',
            {
                type: 'Live_Chat',
                contactId: contactId,
                message: text
            },
            {
                headers: {
                    'Authorization': 'Bearer ' + GHL_API_TOKEN,
                    'Version': '2021-07-28',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );
        console.log('Successfully replied via GHL API!');
    } catch (error) {
        console.error('Failed to reply via GHL:', error.response ? error.response.data : error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Aria Webhook running on port " + PORT));
