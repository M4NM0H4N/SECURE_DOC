'use strict';

// Server-side request forgery protection for outgoing webhooks: a webhook URL must never make the
// server call its own machine, the cloud metadata service or the institution's internal network.
// Checked when the webhook is registered AND again at connection time (the address actually used is
// the one that was checked, which defeats DNS rebinding).
const dns = require('dns');
const net = require('net');

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]]) blocked.addSubnet(addr, bits, 'ipv6');

function isPrivateAddress(address) {
  const kind = net.isIP(address);
  if (kind === 0) return true; // not an address at all: treat as unsafe
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return blocked.check(address, 'ipv4');
}

// A `lookup` function for http(s).request: resolves, refuses private answers, and hands back the
// vetted address so the connection goes exactly there.
function safeLookup({ allowPrivate = false } = {}) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, family: options && options.family ? options.family : 0 }, (err, addresses) => {
      if (err) return callback(err);
      const ok = addresses.filter((a) => allowPrivate || !isPrivateAddress(a.address));
      if (!ok.length) return callback(Object.assign(new Error('The address of this host is not allowed'), { code: 'EBLOCKED' }));
      if (options && options.all) return callback(null, ok);
      return callback(null, ok[0].address, ok[0].family);
    });
  };
}

module.exports = { isPrivateAddress, safeLookup };
