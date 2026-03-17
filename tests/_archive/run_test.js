const cp=require('child_process');
const fs=require('fs');
try {
  const out = cp.execSync('npx mocha tests/websocket.media.test.js', {encoding:'utf8'});
  fs.writeFileSync('output.log', out);
} catch(e) {
  fs.writeFileSync('output.log', "ERROR:\n" + e.stdout + "\n" + e.stderr);
}
