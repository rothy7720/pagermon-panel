'use strict';

const fs = require('fs');
const fsp = fs.promises;

// Read the last `maxBytes` of a file without slurping the whole thing.
async function tailBytes(filePath, maxBytes) {
  if (!filePath) return '';
  let handle;
  try {
    const stat = await fsp.stat(filePath);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    handle = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    let text = buf.toString('utf8');
    // Drop a partial first line when we started mid-file.
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = { tailBytes };
