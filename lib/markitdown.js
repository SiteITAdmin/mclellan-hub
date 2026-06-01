const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BIN = process.env.MARKITDOWN_BIN
  || path.join(__dirname, '../.tools/markitdown-venv/bin/markitdown');

async function convertWithMarkitdown(buffer, filename) {
  const ext = path.extname(filename).toLowerCase() || '.bin';
  const tmp = path.join(os.tmpdir(), `mkhub-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  try {
    fs.writeFileSync(tmp, buffer);
    const markdown = await new Promise((resolve, reject) => {
      let out = '', err = '';
      const proc = spawn(BIN, [tmp]);
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err += d; });
      proc.on('close', code => {
        if (code !== 0) reject(new Error(err.trim() || `markitdown exited ${code}`));
        else resolve(out);
      });
      proc.on('error', e => reject(new Error(`markitdown not found: ${e.message}`)));
      setTimeout(() => { proc.kill(); reject(new Error('markitdown timed out')); }, 30000);
    });
    return { markdown: markdown.trim() };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

module.exports = { convertWithMarkitdown };
