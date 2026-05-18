const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');
const manifest = fs.readFileSync('manifest.webmanifest', 'utf8');
const serviceWorker = fs.readFileSync('sw.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const gitignore = fs.readFileSync('.gitignore', 'utf8');
const envExample = fs.readFileSync('.env.example', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const requiredSnippets = [
  '<!DOCTYPE html>',
  'Voca — Hey Todo',
  'Wake phrase: “Hey Todo”',
  'function startListening()',
  'function startWakeWord()',
  'function parseNaturalLanguage(raw)',
  'class="waveform"',
  'class="bottom-nav"',
  'manifest.webmanifest',
  'navigator.serviceWorker.register',

  'Collaborative Productivity Messenger',
  'function renderCollaboration()',
  'function sendMessage()',
  'function addSharedTask()',
  'REALTIME_CONFIG',
  'Supabase realtime ready',
  'GEMINI_ACTION_ENDPOINT',
  'function analyzeProductivityIntent',
  'function confirmSmartAction',
  'Suggested Task Detected',
];

for (const snippet of requiredSnippets) {
  if (!html.includes(snippet)) {
    throw new Error(`Missing expected snippet: ${snippet}`);
  }
}

if (!server.includes("gemini-2.5-flash") || !server.includes("/api/gemini/actions")) {
  throw new Error('Server should expose the Gemini action extraction endpoint.');
}

if (!server.includes("loadLocalEnv(path.join(ROOT, '.env'))") || !server.includes('process.env.GEMINI_API_KEY')) {
  throw new Error('Server should load Gemini credentials from a local .env file.');
}

if (!gitignore.includes('.env') || !envExample.includes('GEMINI_API_KEY=your_gemini_api_key_here')) {
  throw new Error('Gemini API key setup should be documented without committing secrets.');
}

if (pkg.scripts.start !== 'node server.js') {
  throw new Error('Start script should run the backend server.');
}

const parsedManifest = JSON.parse(manifest);
if (parsedManifest.short_name !== 'Voca') {
  throw new Error('Manifest short_name should be Voca.');
}

for (const asset of ['./index.html', './manifest.webmanifest', './favicon.svg']) {
  if (!serviceWorker.includes(asset)) {
    throw new Error(`Service worker missing cached asset: ${asset}`);
  }
}

console.log('Static smoke test passed.');
