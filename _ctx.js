import fs from 'fs';
const t = fs.readFileSync('src/websocket/connection_manager.js', 'utf8');
const lines = t.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('conversationBuffer') || lines[i].includes('createConnection') || lines[i].includes('new Connection') || lines[i].includes('class Connection')) {
    console.log((i + 1) + ': ' + lines[i]);
  }
}
