import { CONFIG } from "../config.js";

export async function chatwootCreateMessage(conversationId, content) {
  if (!CONFIG.CHATWOOT_ACCOUNT_ID || !CONFIG.CHATWOOT_API_TOKEN) {
    throw new Error("Missing CHATWOOT_ACCOUNT_ID or CHATWOOT_API_TOKEN");
  }

  const url = `${CONFIG.CHATWOOT_BASE_URL}/api/v1/accounts/${CONFIG.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api_access_token": CONFIG.CHATWOOT_API_TOKEN
    },
    body: JSON.stringify({
      content,
      message_type: "outgoing",
      private: false,
      content_type: "text",
      content_attributes: {}
    })
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Chatwoot message failed ${r.status}: ${t}`);
  }
}

export async function chatwootSetLabels(conversationId, labels) {
  if (!CONFIG.CHATWOOT_ACCOUNT_ID || !CONFIG.CHATWOOT_API_TOKEN) return;

  const url = `${CONFIG.CHATWOOT_BASE_URL}/api/v1/accounts/${CONFIG.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api_access_token": CONFIG.CHATWOOT_API_TOKEN
    },
    body: JSON.stringify({ labels })
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Chatwoot labels failed ${r.status}: ${t}`);
  }
}
