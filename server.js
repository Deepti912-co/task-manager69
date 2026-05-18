const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
loadLocalEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 4173);
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_BODY_BYTES = 1024 * 1024;
const DATA_DIR = path.join(ROOT, '.data');
const REMINDER_DB_PATH = path.join(DATA_DIR, 'reminders.json');
const REMINDER_CHECK_INTERVAL_MS = 60 * 1000;
const REMINDER_RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ACTIONS = new Set([
  'create_task',
  'assign_task',
  'set_deadline',
  'set_priority',
  'create_reminder',
  'update_task_status',
]);
const PRIORITIES = new Set(['low', 'medium', 'high']);
const STATUSES = new Set(['todo', 'in_progress', 'done', 'blocked']);


function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const separatorIndex = trimmed.indexOf('=');
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function toISODate(value) {
  if (!value || typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function cleanString(value, max = 160) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function normalizeAction(action, context = {}) {
  if (!action || typeof action !== 'object') return null;
  const type = cleanString(action.type, 40).toLowerCase();
  if (!ALLOWED_ACTIONS.has(type)) return null;

  const normalized = { type };
  const title = cleanString(action.title || action.taskTitle || action.task || action.text);
  const assignedTo = cleanString(action.assignedTo || action.assignee || action.owner, 80);
  const priority = cleanString(action.priority, 20).toLowerCase();
  const status = cleanString(action.status || action.taskStatus, 30).toLowerCase();
  const reminderText = cleanString(action.reminderText || action.message || action.title || action.text);
  const dueDate = toISODate(action.dueDate || action.deadline || action.date);
  const reminderDate = toISODate(action.reminderDate || action.dueDate || action.date);

  if (title) normalized.title = title;
  if (assignedTo) normalized.assignedTo = assignedTo;
  if (dueDate) normalized.dueDate = dueDate;
  if (reminderDate) normalized.reminderDate = reminderDate;
  if (PRIORITIES.has(priority)) normalized.priority = priority;
  if (STATUSES.has(status)) normalized.status = status;
  if (reminderText) normalized.reminderText = reminderText;

  if (type === 'create_task' && !normalized.title) return null;
  if (type === 'assign_task' && (!normalized.title || !normalized.assignedTo)) return null;
  if (type === 'set_deadline' && (!normalized.title || !normalized.dueDate)) return null;
  if (type === 'set_priority' && (!normalized.title || !normalized.priority)) return null;
  if (type === 'create_reminder' && !normalized.reminderText) return null;
  if (type === 'update_task_status' && (!normalized.title || !normalized.status)) return null;

  if (!normalized.priority && (type === 'create_task' || type === 'assign_task')) normalized.priority = 'medium';
  if (!normalized.assignedTo && type === 'create_task') normalized.assignedTo = context.currentUserName || 'You';
  return normalized;
}

function validateActions(rawActions, context) {
  const source = Array.isArray(rawActions) ? rawActions : [];
  const seen = new Set();
  const actions = [];
  for (const rawAction of source) {
    const action = normalizeAction(rawAction, context);
    if (!action) continue;
    const key = [action.type, action.title || action.reminderText, action.assignedTo || '', action.dueDate || action.reminderDate || '', action.priority || '', action.status || ''].join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(action);
  }
  return actions.slice(0, 8);
}

function buildPrompt(message, context) {
  const today = context.currentDate || new Date().toISOString().slice(0, 10);
  const members = (Array.isArray(context.members) ? context.members : []).map(member => ({
    id: cleanString(member.id, 50),
    name: cleanString(member.name, 80),
  })).filter(member => member.name);
  const tasks = (Array.isArray(context.tasks) ? context.tasks : []).map(task => ({
    id: cleanString(task.id, 50),
    title: cleanString(task.title || task.text, 120),
    assignedTo: cleanString(task.assignedTo, 80),
    priority: cleanString(task.priority, 20),
    dueDate: cleanString(task.due || task.dueDate, 20),
    done: Boolean(task.done),
  })).filter(task => task.title).slice(0, 30);

  return `You are an intelligent productivity action extraction engine for a collaborative task platform. You are not a chatbot and must not answer conversationally.

Return ONLY strict JSON with this shape: {"actions":[...]}.
If the message has no clear productivity action, return {"actions":[]}.
Supported action types only:
- create_task: {"type":"create_task","title":"...","assignedTo":"member name or You","dueDate":"YYYY-MM-DD","priority":"low|medium|high"}
- assign_task: {"type":"assign_task","title":"...","assignedTo":"member name"}
- set_deadline: {"type":"set_deadline","title":"...","dueDate":"YYYY-MM-DD"}
- set_priority: {"type":"set_priority","title":"...","priority":"low|medium|high"}
- create_reminder: {"type":"create_reminder","reminderText":"...","reminderDate":"YYYY-MM-DD"}
- update_task_status: {"type":"update_task_status","title":"...","status":"todo|in_progress|done|blocked"}

Rules:
- Resolve relative dates using today=${today}.
- Detect names, ownership, urgency, reminders, deadlines, multiple tasks, and status updates.
- Prefer known member names when assigning work.
- Do not invent actions for unclear intent.
- Do not include explanations, Markdown, code fences, or text outside JSON.

Known members: ${JSON.stringify(members)}
Existing tasks: ${JSON.stringify(tasks)}
Message: ${JSON.stringify(message)}`;
}

async function callGemini(message, context) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return { actions: [], warning: 'Gemini API key is not configured on the server.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(message, context) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          topP: 0.8,
          maxOutputTokens: 1200,
        },
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${detail.slice(0, 200)}`);
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim() || '{"actions":[]}';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error('Gemini returned invalid JSON.');
    }
    return { actions: validateActions(parsed.actions, context) };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleActionExtraction(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const message = cleanString(payload.message, 1000);
    const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
    if (!message) return sendJson(res, 400, { actions: [], error: 'Message is required.' });
    const result = await callGemini(message, context);
    return sendJson(res, 200, { actions: result.actions, engine: GEMINI_MODEL, warning: result.warning || null });
  } catch (error) {
    const status = error.statusCode || (error.name === 'AbortError' ? 504 : 422);
    return sendJson(res, status, { actions: [], error: error.name === 'AbortError' ? 'Gemini timed out.' : error.message });
  }
}


function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function emptyReminderDb() {
  return { reminders: [], pushSubscriptions: [], deliveryEvents: [] };
}

function readReminderDb() {
  ensureDataDir();
  if (!fs.existsSync(REMINDER_DB_PATH)) return emptyReminderDb();
  try {
    const parsed = JSON.parse(fs.readFileSync(REMINDER_DB_PATH, 'utf8'));
    return {
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      pushSubscriptions: Array.isArray(parsed.pushSubscriptions) ? parsed.pushSubscriptions : [],
      deliveryEvents: Array.isArray(parsed.deliveryEvents) ? parsed.deliveryEvents : [],
    };
  } catch (error) {
    console.error('Failed to read reminder database:', error.message);
    return emptyReminderDb();
  }
}

function writeReminderDb(db) {
  ensureDataDir();
  const tempPath = `${REMINDER_DB_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(db, null, 2));
  fs.renameSync(tempPath, REMINDER_DB_PATH);
}

function supabaseConfig() {
  const url = cleanString(process.env.SUPABASE_URL, 500).replace(/\/$/, '');
  const key = cleanString(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY, 2000);
  return { url, key, enabled: Boolean(url && key) };
}

function shouldUseSupabase(userId) {
  return supabaseConfig().enabled && UUID_RE.test(userId);
}

function supabaseHeaders(prefer) {
  const { key } = supabaseConfig();
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    ...(prefer ? { prefer } : {}),
  };
}

async function supabaseRequest(pathname, options = {}) {
  const { url } = supabaseConfig();
  const response = await fetch(`${url}${pathname}`, { ...options, headers: { ...supabaseHeaders(options.prefer), ...(options.headers || {}) } });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.error || `Supabase request failed with ${response.status}`);
  return data;
}

function reminderFromSupabase(row) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description || '',
    scheduledTime: row.scheduled_time,
    timezone: row.timezone || 'UTC',
    sent: Boolean(row.sent),
    createdAt: row.created_at,
    sentAt: row.sent_at || null,
    deliveryStatus: row.delivery_status || 'pending',
    attempts: row.attempts || 0,
    lastError: row.last_error || null,
    nextAttemptAt: row.next_attempt_at || row.scheduled_time,
  };
}

function reminderToSupabase(reminder) {
  return {
    user_id: reminder.userId,
    title: reminder.title,
    description: reminder.description,
    scheduled_time: reminder.scheduledTime,
    timezone: reminder.timezone,
    sent: reminder.sent,
    delivery_status: reminder.deliveryStatus,
    attempts: reminder.attempts,
    next_attempt_at: reminder.nextAttemptAt,
    last_error: reminder.lastError,
    sent_at: reminder.sentAt,
  };
}

async function createSupabaseReminder(reminder) {
  const rows = await supabaseRequest('/rest/v1/reminders?select=*', {
    method: 'POST',
    prefer: 'return=representation',
    body: JSON.stringify(reminderToSupabase(reminder)),
  });
  return reminderFromSupabase(rows[0]);
}

async function listSupabaseReminders(userId) {
  const rows = await supabaseRequest(`/rest/v1/reminders?select=*&user_id=eq.${encodeURIComponent(userId)}&order=scheduled_time.asc`, { method: 'GET' });
  return rows.map(reminderFromSupabase);
}

async function upsertSupabasePushSubscription(record) {
  await supabaseRequest('/rest/v1/push_subscriptions?on_conflict=endpoint', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({
      user_id: record.userId,
      endpoint: record.subscription.endpoint,
      p256dh: record.subscription.keys.p256dh,
      auth: record.subscription.keys.auth,
      timezone: record.timezone,
      enabled: true,
      last_seen_at: record.lastSeenAt,
    }),
  });
}

async function listSupabasePushSubscriptions(userId) {
  const rows = await supabaseRequest(`/rest/v1/push_subscriptions?select=*&user_id=eq.${encodeURIComponent(userId)}&enabled=eq.true`, { method: 'GET' });
  return rows.map(row => ({ id: row.id, userId: row.user_id, subscription: { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, enabled: row.enabled }));
}

async function patchSupabaseReminder(id, patch) {
  await supabaseRequest(`/rest/v1/reminders?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: JSON.stringify(patch),
  });
}

async function insertSupabaseDeliveryEvent(event) {
  await supabaseRequest('/rest/v1/reminder_delivery_events', {
    method: 'POST',
    prefer: 'return=minimal',
    body: JSON.stringify({ reminder_id: event.reminderId, user_id: event.userId, channel: event.channel, status: event.status, error: event.error || null }),
  });
}

async function processSupabaseDueReminders() {
  const claimed = await supabaseRequest('/rest/v1/rpc/claim_due_reminders', { method: 'POST', body: JSON.stringify({ batch_size: 100 }) });
  const now = new Date();
  let processed = 0;
  for (const row of claimed) {
    const reminder = reminderFromSupabase(row);
    const subscriptions = await listSupabasePushSubscriptions(reminder.userId);
    const errors = [];
    let delivered = false;
    for (const record of subscriptions) {
      try {
        await sendWebPush(record.subscription, reminder);
        delivered = true;
        await insertSupabaseDeliveryEvent({ reminderId: reminder.id, userId: reminder.userId, channel: 'web_push', status: 'sent' });
      } catch (error) {
        errors.push(error.message);
        await insertSupabaseDeliveryEvent({ reminderId: reminder.id, userId: reminder.userId, channel: 'web_push', status: error.expired ? 'expired' : 'failed', error: error.message });
      }
    }
    if (delivered || !subscriptions.length) {
      await patchSupabaseReminder(reminder.id, { sent: true, sent_at: new Date().toISOString(), delivery_status: delivered ? 'sent' : 'fallback_required', last_error: delivered ? null : 'No active push subscriptions. Email or Telegram fallback can be attached by the notification worker.' });
      processed++;
    } else {
      const delay = REMINDER_RETRY_DELAYS_MS[Math.min((reminder.attempts || 1) - 1, REMINDER_RETRY_DELAYS_MS.length - 1)];
      await patchSupabaseReminder(reminder.id, { delivery_status: 'retry_scheduled', last_error: errors.join(' | ') || 'Unknown push delivery failure.', next_attempt_at: new Date(Date.now() + delay).toISOString() });
    }
  }
  return { checked: claimed.length, processed, now: now.toISOString(), store: 'supabase' };
}

function normalizeUserId(value) {
  return cleanString(value, 120) || 'local-user';
}

function parseScheduledTime(value) {
  if (!value || typeof value !== 'string') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function publicVapidKey() {
  return cleanString(process.env.VAPID_PUBLIC_KEY, 2000);
}

function privateVapidKey() {
  return cleanString(process.env.VAPID_PRIVATE_KEY, 2000);
}

function base64UrlToBuffer(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createVapidJwt(audience) {
  const publicKey = publicVapidKey();
  const privateKey = privateVapidKey();
  if (!publicKey || !privateKey) return null;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  const header = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = base64UrlEncode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: subject }));
  const signer = crypto.createSign('SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  const publicBuffer = base64UrlToBuffer(publicKey);
  const privateBuffer = base64UrlToBuffer(privateKey);
  if (publicBuffer.length !== 65 || publicBuffer[0] !== 4 || privateBuffer.length !== 32) {
    throw new Error('VAPID keys must be URL-safe base64 P-256 keys generated for Web Push.');
  }
  const keyObject = crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(publicBuffer.subarray(1, 33)),
      y: base64UrlEncode(publicBuffer.subarray(33, 65)),
      d: base64UrlEncode(privateBuffer),
    },
    format: 'jwk',
  });
  const signature = signer.sign({ key: keyObject, dsaEncoding: 'ieee-p1363' });
  return `${header}.${body}.${base64UrlEncode(signature)}`;
}

function validateSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object') return null;
  const endpoint = cleanString(subscription.endpoint, 2048);
  const p256dh = cleanString(subscription.keys?.p256dh, 512);
  const auth = cleanString(subscription.keys?.auth, 512);
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, expirationTime: subscription.expirationTime || null, keys: { p256dh, auth } };
}

async function sendWebPush(subscription, reminder) {
  const endpointUrl = new URL(subscription.endpoint);
  const jwt = createVapidJwt(endpointUrl.origin);
  if (!jwt) throw new Error('VAPID keys are not configured; set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      ttl: '2419200',
      urgency: 'high',
      authorization: `vapid t=${jwt}, k=${publicVapidKey()}`,
      'content-length': '0',
    },
  });
  if (response.status === 404 || response.status === 410) {
    const error = new Error('Push subscription expired.');
    error.expired = true;
    throw error;
  }
  if (!response.ok && response.status !== 201) {
    throw new Error(`Push service responded with ${response.status}.`);
  }
  return { ok: true, status: response.status, endpoint: subscription.endpoint, reminderId: reminder.id };
}

function reminderForClient(reminder) {
  return {
    id: reminder.id,
    userId: reminder.userId,
    title: reminder.title,
    description: reminder.description,
    scheduledTime: reminder.scheduledTime,
    timezone: reminder.timezone,
    sent: Boolean(reminder.sent),
    createdAt: reminder.createdAt,
    sentAt: reminder.sentAt || null,
    deliveryStatus: reminder.deliveryStatus || 'pending',
    attempts: reminder.attempts || 0,
    lastError: reminder.lastError || null,
  };
}

async function handleCreateReminder(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const scheduledTime = parseScheduledTime(payload.scheduledTime);
    const title = cleanString(payload.title || payload.text, 160);
    if (!title) return sendJson(res, 400, { error: 'Reminder title is required.' });
    if (!scheduledTime) return sendJson(res, 400, { error: 'scheduledTime must be a valid ISO timestamp.' });
    const db = readReminderDb();
    const reminder = {
      id: crypto.randomUUID(),
      userId: normalizeUserId(payload.userId),
      title,
      description: cleanString(payload.description, 600),
      scheduledTime,
      timezone: cleanString(payload.timezone, 80) || 'UTC',
      sent: false,
      createdAt: new Date().toISOString(),
      sentAt: null,
      deliveryStatus: 'pending',
      attempts: 0,
      lastError: null,
      nextAttemptAt: scheduledTime,
    };
    if (shouldUseSupabase(reminder.userId)) {
      const stored = await createSupabaseReminder(reminder);
      return sendJson(res, 201, { reminder: reminderForClient(stored), store: 'supabase' });
    }
    db.reminders.push(reminder);
    writeReminderDb(db);
    return sendJson(res, 201, { reminder: reminderForClient(reminder), store: 'local' });
  } catch (error) {
    return sendJson(res, error.statusCode || 422, { error: error.message });
  }
}

async function handleListReminders(req, res, requestUrl) {
  try {
    const userId = normalizeUserId(requestUrl.searchParams.get('userId'));
    if (shouldUseSupabase(userId)) {
      const reminders = (await listSupabaseReminders(userId)).map(reminderForClient);
      return sendJson(res, 200, { reminders, now: new Date().toISOString(), store: 'supabase' });
    }
    const db = readReminderDb();
    const reminders = db.reminders.filter(reminder => reminder.userId === userId).sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime)).map(reminderForClient);
    return sendJson(res, 200, { reminders, now: new Date().toISOString(), store: 'local' });
  } catch (error) {
    return sendJson(res, 500, { reminders: [], error: error.message });
  }
}

async function handleSubscribePush(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const subscription = validateSubscription(payload.subscription);
    if (!subscription) return sendJson(res, 400, { error: 'A valid PushSubscription is required.' });
    const db = readReminderDb();
    const userId = normalizeUserId(payload.userId);
    const existingIndex = db.pushSubscriptions.findIndex(item => item.endpoint === subscription.endpoint);
    const record = { id: crypto.randomUUID(), userId, subscription, timezone: cleanString(payload.timezone, 80) || 'UTC', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), enabled: true };
    if (shouldUseSupabase(userId)) {
      await upsertSupabasePushSubscription(record);
      return sendJson(res, 201, { ok: true, vapidConfigured: Boolean(publicVapidKey() && privateVapidKey()), store: 'supabase' });
    }
    if (existingIndex >= 0) db.pushSubscriptions[existingIndex] = { ...db.pushSubscriptions[existingIndex], ...record, id: db.pushSubscriptions[existingIndex].id };
    else db.pushSubscriptions.push(record);
    writeReminderDb(db);
    return sendJson(res, 201, { ok: true, vapidConfigured: Boolean(publicVapidKey() && privateVapidKey()), store: 'local' });
  } catch (error) {
    return sendJson(res, error.statusCode || 422, { error: error.message });
  }
}

function handleVapidPublicKey(req, res) {
  return sendJson(res, 200, { publicKey: publicVapidKey(), configured: Boolean(publicVapidKey() && privateVapidKey()) });
}

function handleReminderDeliveries(req, res, requestUrl) {
  const userId = normalizeUserId(requestUrl.searchParams.get('userId'));
  const since = Date.now() - 10 * 60 * 1000;
  const db = readReminderDb();
  const deliveries = db.reminders
    .filter(reminder => reminder.userId === userId && reminder.sent && Date.parse(reminder.sentAt || reminder.scheduledTime) >= since)
    .sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')))
    .slice(0, 5)
    .map(reminderForClient);
  return sendJson(res, 200, { deliveries });
}

async function processDueReminders() {
  let supabaseResult = null;
  if (supabaseConfig().enabled) supabaseResult = await processSupabaseDueReminders();
  const db = readReminderDb();
  const now = new Date();
  const due = db.reminders.filter(reminder => !reminder.sent && Date.parse(reminder.scheduledTime) <= now.getTime() && Date.parse(reminder.nextAttemptAt || reminder.scheduledTime) <= now.getTime());
  let processed = 0;
  for (const reminder of due) {
    reminder.attempts = (reminder.attempts || 0) + 1;
    reminder.deliveryStatus = 'sending';
    const subscriptions = db.pushSubscriptions.filter(item => item.userId === reminder.userId && item.enabled);
    const errors = [];
    let delivered = false;
    for (const record of subscriptions) {
      try {
        await sendWebPush(record.subscription, reminder);
        delivered = true;
        db.deliveryEvents.push({ id: crypto.randomUUID(), reminderId: reminder.id, userId: reminder.userId, channel: 'web_push', status: 'sent', createdAt: new Date().toISOString() });
      } catch (error) {
        errors.push(error.message);
        db.deliveryEvents.push({ id: crypto.randomUUID(), reminderId: reminder.id, userId: reminder.userId, channel: 'web_push', status: 'failed', error: error.message, createdAt: new Date().toISOString() });
        if (error.expired) record.enabled = false;
      }
    }
    if (delivered || !subscriptions.length) {
      reminder.sent = true;
      reminder.sentAt = new Date().toISOString();
      reminder.deliveryStatus = delivered ? 'sent' : 'fallback_required';
      reminder.lastError = delivered ? null : 'No active push subscriptions. Email or Telegram fallback can be attached by the notification worker.';
      processed++;
    } else {
      const delay = REMINDER_RETRY_DELAYS_MS[Math.min(reminder.attempts - 1, REMINDER_RETRY_DELAYS_MS.length - 1)];
      reminder.deliveryStatus = 'retry_scheduled';
      reminder.lastError = errors.join(' | ') || 'Unknown push delivery failure.';
      reminder.nextAttemptAt = new Date(Date.now() + delay).toISOString();
    }
  }
  if (due.length) writeReminderDb(db);
  if (supabaseResult) {
    return { checked: due.length + supabaseResult.checked, processed: processed + supabaseResult.processed, now: now.toISOString(), stores: ['supabase', 'local'] };
  }
  return { checked: due.length, processed, now: now.toISOString(), store: 'local' };
}

async function handleReminderCron(req, res) {
  try {
    const expected = process.env.CRON_SECRET;
    if (expected && req.headers.authorization !== `Bearer ${expected}`) return sendJson(res, 401, { error: 'Unauthorized cron request.' });
    const result = await processDueReminders();
    return sendJson(res, 200, result);
  } catch (error) {
    console.error('Reminder cron failed:', error);
    return sendJson(res, 500, { error: error.message });
  }
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(ROOT, 'index.html'), (fallbackError, fallback) => {
        if (fallbackError) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fallback);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'POST' && requestUrl.pathname === '/api/gemini/actions') return handleActionExtraction(req, res);
  if (req.method === 'GET' && requestUrl.pathname === '/api/push/vapid-public-key') return handleVapidPublicKey(req, res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/push/subscribe') return handleSubscribePush(req, res);
  if (req.method === 'POST' && requestUrl.pathname === '/api/reminders') return handleCreateReminder(req, res);
  if (req.method === 'GET' && requestUrl.pathname === '/api/reminders') return handleListReminders(req, res, requestUrl);
  if (req.method === 'GET' && requestUrl.pathname === '/api/reminders/deliveries') return handleReminderDeliveries(req, res, requestUrl);
  if ((req.method === 'GET' || req.method === 'POST') && requestUrl.pathname === '/api/cron/reminders') return handleReminderCron(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405, { allow: 'GET, HEAD, POST' });
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Voca server running at http://localhost:${PORT}`);
  console.log(`Gemini action engine model: ${GEMINI_MODEL}`);
  console.log(`Reminder scheduler checks every ${REMINDER_CHECK_INTERVAL_MS / 1000}s and exposes /api/cron/reminders for Vercel Cron.`);
});

setInterval(() => {
  processDueReminders().catch(error => console.error('Reminder scheduler failed:', error));
}, REMINDER_CHECK_INTERVAL_MS).unref();
