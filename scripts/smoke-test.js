const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');
const manifest = fs.readFileSync('manifest.webmanifest', 'utf8');
const serviceWorker = fs.readFileSync('sw.js', 'utf8');

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
];

for (const snippet of requiredSnippets) {
  if (!html.includes(snippet)) {
    throw new Error(`Missing expected snippet: ${snippet}`);
  }
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
