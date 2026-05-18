const fs = require('node:fs');
const html = fs.readFileSync('index.html', 'utf8');

const requiredSnippets = [
  '<!DOCTYPE html>',
  'hey todo',
  'voice assistant',
  'function addManual()',
  'function startWakeWord()',
  'loadTasks().then(()=>setTimeout(startWakeWord,800));',
];

for (const snippet of requiredSnippets) {
  if (!html.includes(snippet)) {
    throw new Error(`Missing expected snippet: ${snippet}`);
  }
}

console.log('Static smoke test passed.');
