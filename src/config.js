export const CONFIG = Object.freeze({
  PORT: process.env.PORT || 10000,
  KNOWLEDGE_URL: process.env.KNOWLEDGE_URL || process.env.KNOWLEDGE_V5_URL || "",
  CHATWOOT_BASE_URL: process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com",
  CHATWOOT_ACCOUNT_ID: process.env.CHATWOOT_ACCOUNT_ID || "",
  CHATWOOT_API_TOKEN: process.env.CHATWOOT_API_TOKEN || ""
});
