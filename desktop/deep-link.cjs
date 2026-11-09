const PROTOCOL = 'together-watch';
function parseInvitation(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const link = new URL(value);
    if (link.protocol !== `${PROTOCOL}:` || link.hostname !== 'join' || !['', '/'].includes(link.pathname) || link.username || link.password || link.hash) return null;
    const code = link.searchParams.get('code');
    if (!/^[A-Z2-7]{8}-[A-Za-z0-9_-]{12}$/i.test(code || '')) return null;
    const server = new URL(link.searchParams.get('server'));
    if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.pathname !== '/' || server.search || server.hash) return null;
    return { server: server.origin, code: code.slice(0, 8).toUpperCase() + code.slice(8) };
  } catch { return null; }
}
module.exports = { PROTOCOL, parseInvitation };
