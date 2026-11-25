function privateNetworkOrigin(interfaces, port) {
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!/tailscale/i.test(name)) continue;
    for (const info of addresses || []) {
      if (info.internal || !['IPv4', 4].includes(info.family)) continue;
      const parts = info.address.split('.').map(Number);
      if (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
        && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) return `http://${info.address}:${port}`;
    }
  }
  return null;
}
module.exports = { privateNetworkOrigin };
