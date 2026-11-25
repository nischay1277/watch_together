const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function normalizeParty(value) {
  if (!value || typeof value !== 'object' || typeof value.invite !== 'string' || value.invite.length > 4096) throw new Error('Invalid party invitation.');
  let url;
  try { url = new URL(value.invite); } catch { throw new Error('Use a complete party invitation.'); }
  const code = new URLSearchParams(url.hash.slice(1)).get('code');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/'
    || (url.search && url.search !== '?open=app') || !/^[A-Z2-7]{8}-[A-Za-z0-9_-]{12}$/i.test(code || '')) throw new Error('Invalid party invitation.');
  const title = typeof value.title === 'string' ? value.title.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 60) : '';
  const invite = `${url.origin}/#code=${code.slice(0, 8).toUpperCase()}${code.slice(8)}`;
  return { id: createHash('sha256').update(invite).digest('hex').slice(0, 24), title: title || 'Friends’ party', invite };
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function createPartyStore(file) {
  function list() {
    if (!fs.existsSync(file)) return [];
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(saved) || saved.length > 50) throw new Error();
      return saved.map(normalizeParty);
    } catch { throw new Error('Saved parties could not be read. Keep the saved-parties.json file for recovery.'); }
  }
  function save(value) {
    const party = normalizeParty(value);
    const items = list();
    const index = items.findIndex(item => item.id === party.id);
    if (index >= 0) items[index] = party;
    else { if (items.length >= 50) throw new Error('You can save up to 50 parties. Remove one before adding another.'); items.push(party); }
    writeJsonAtomic(file, items);
    return items;
  }
  function remove(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid saved party.');
    const items = list().filter(item => item.id !== id);
    writeJsonAtomic(file, items);
    return items;
  }
  return { list, save, remove };
}
async function startStableServer({ dataRoot, createServer, options = {} }) {
  const settingsFile = path.join(dataRoot, 'server-settings.json');
  let preferredPort = 4317;
  try {
    const port = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).port;
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) preferredPort = port;
  } catch {}
  let service;
  try { service = await createServer({ ...options, port: preferredPort }); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    service = await createServer({ ...options, port: 0 });
  }
  try { writeJsonAtomic(settingsFile, { port: service.port }); }
  catch (error) { await service.close(); throw error; }
  return { service, portChanged: service.port !== preferredPort };
}
module.exports = { normalizeParty, createPartyStore, startStableServer };
