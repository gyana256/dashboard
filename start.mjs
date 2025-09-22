import fs from 'fs/promises';
import path from 'path';

const serverPath = path.resolve(process.cwd(), 'server.js');
try {
  let content = await fs.readFile(serverPath, 'utf8');
  const marker = "import express from 'express'";
  const first = content.indexOf(marker);
  const second = content.indexOf(marker, first + 1);
  if(second !== -1){
    console.warn('[start.mjs] Detected duplicated server.js content. Creating backup and trimming to first copy.');
    const bak = serverPath + '.bak.' + new Date().toISOString().replace(/[:.]/g,'-');
    await fs.copyFile(serverPath, bak);
    const trimmed = content.slice(0, second);
    await fs.writeFile(serverPath, trimmed, 'utf8');
    console.warn('[start.mjs] Trimmed server.js and saved backup to', bak);
    content = trimmed;
  }
} catch(e){
  console.error('[start.mjs] Failed to inspect/repair server.js:', e.message);
}

// Finally, import the server (it should export nothing and just start)
try {
  await import(pathToFileURL(serverPath).href);
} catch(e){
  // If dynamic import fails, show full error
  console.error('[start.mjs] Failed to import server.js:', e);
  process.exit(1);
}

function pathToFileURL(p){
  const url = new URL('file:///' + p);
  return url;
}
