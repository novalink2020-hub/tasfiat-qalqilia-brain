// src/chatwoot/cartFollowupLock.js
const pendingCartFollowups = new Map(); // convId -> timeoutId | "__LOCK__"

export function tryLockCartFollowup(convId) {
  const key = String(convId || "");
  if (!key) return false;
  if (pendingCartFollowups.has(key)) return false;
  pendingCartFollowups.set(key, "__LOCK__");
  return true;
}

export function setCartFollowupTimeoutId(convId, timeoutId) {
  const key = String(convId || "");
  if (!key) return;
  pendingCartFollowups.set(key, timeoutId);
}

export function unlockCartFollowup(convId) {
  const key = String(convId || "");
  if (!key) return;
  pendingCartFollowups.delete(key);
}
