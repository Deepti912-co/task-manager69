const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
loadLocalEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 4173);
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_BODY_BYTES = 1024 * 1024;
const REMINDER_WEBHOOK_PATH = '/api/reminders/deliver';
const reminderStore = new Map();
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

function getBaseUrl(req) {
  const host = process.env.APP_BASE_URL || `http://${req.headers.host || `localhost:${PORT}`}`;
  return host.replace(/\/$/, '');
}

function toUTCISOString(value) {
  if (!value || typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function sendPushNotification(payload) {
  if (!process.env.WEB_PUSH_ENDPOINT) return { delivered: false, error: 'Push endpoint not configured' };
  const response = await fetch(process.env.WEB_PUSH_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.WEB_PUSH_AUTH ? { authorization: `Bearer ${process.env.WEB_PUSH_AUTH}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Push delivery failed (${response.status})`);
  return { delivered: true };
}

async function scheduleReminderWebhook(req, reminder) {
  const qstashToken = process.env.QSTASH_TOKEN;
  const publishUrl = process.env.QSTASH_URL || 'https://qstash.upstash.io/v2/publish';
  if (!qstashToken) return { scheduled: false, warning: 'QStash token is not configured' };
  const targetUrl = `${getBaseUrl(req)}${REMINDER_WEBHOOK_PATH}`;
  const response = await fetch(publishUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${qstashToken}`,
      'content-type': 'application/json',
      'upstash-delay': `${Math.max(0, Math.floor((new Date(reminder.remindAt).getTime() - Date.now()) / 1000))}s`,
      'upstash-retries': '5',
      'upstash-method': 'POST',
      'upstash-forward-Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: targetUrl,
      body: {
        reminderId: reminder.id,
      },
    }),
  });
  if (!response.ok) throw new Error(`QStash scheduling failed (${response.status})`);
  const data = await response.json().catch(() => ({}));
  return { scheduled: true, messageId: data.messageId || data.message_id || null };
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

async function handleReminderCreate(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const title = cleanString(payload.title || payload.reminderText, 140);
    const remindAt = toUTCISOString(payload.remindAt || payload.reminderDate || payload.dueDate);
    const timezone = cleanString(payload.timezone || 'UTC', 80) || 'UTC';
    const userId = cleanString(payload.userId || 'local-user', 80);
    if (!title || !remindAt) return sendJson(res, 400, { error: 'title and remindAt are required' });
    const reminder = {
      id: crypto.randomUUID(),
      title,
      userId,
      timezone,
      remindAt,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      status: 'scheduled',
      deliveryEvents: [],
    };
    reminderStore.set(reminder.id, reminder);
    let scheduleResult = { scheduled: false };
    try {
      scheduleResult = await scheduleReminderWebhook(req, reminder);
      reminder.qstashMessageId = scheduleResult.messageId || null;
    } catch (error) {
      reminder.status = 'schedule_failed';
      reminder.deliveryEvents.push({ at: new Date().toISOString(), type: 'schedule_failed', detail: error.message });
    }
    return sendJson(res, 201, { reminder, schedule: scheduleResult });
  } catch (error) {
    return sendJson(res, 422, { error: error.message });
  }
}

async function handleReminderDeliver(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const reminderId = cleanString(payload.reminderId, 80);
    const reminder = reminderStore.get(reminderId);
    if (!reminder) return sendJson(res, 404, { error: 'Reminder not found' });
    if (reminder.status === 'delivered') return sendJson(res, 200, { ok: true, reminder });
    try {
      await sendPushNotification({
        type: 'reminder',
        title: 'Reminder',
        body: reminder.title,
        reminderId,
        url: '/?tab=notifications',
      });
      reminder.status = 'delivered';
      reminder.deliveredAt = new Date().toISOString();
      reminder.deliveryEvents.push({ at: reminder.deliveredAt, type: 'delivered' });
    } catch (error) {
      reminder.status = 'delivery_failed';
      reminder.deliveryEvents.push({ at: new Date().toISOString(), type: 'delivery_failed', detail: error.message });
      return sendJson(res, 502, { error: error.message, reminder });
    }
    return sendJson(res, 200, { ok: true, reminder });
  } catch (error) {
    return sendJson(res, 422, { error: error.message });
  }
}

function handleReminderList(res) {
  sendJson(res, 200, { reminders: Array.from(reminderStore.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
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
  if (req.method === 'POST' && req.url === '/api/gemini/actions') return handleActionExtraction(req, res);
  if (req.method === 'POST' && req.url === '/api/reminders') return handleReminderCreate(req, res);
  if (req.method === 'POST' && req.url === REMINDER_WEBHOOK_PATH) return handleReminderDeliver(req, res);
  if (req.method === 'GET' && req.url === '/api/reminders') return handleReminderList(res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405, { allow: 'GET, HEAD, POST' });
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Voca server running at http://localhost:${PORT}`);
  console.log(`Gemini action engine model: ${GEMINI_MODEL}`);
});
