// Lightweight loader — import the implementation which contains the actual server code.
import('./server.impl.js').catch(err => { console.error('Failed to start server implementation:', err); process.exit(1); });
