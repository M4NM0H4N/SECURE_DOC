'use strict';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * True only when EVERY host in a classic `mongodb://` connection string is a
 * loopback address. `mongodb+srv://` (Atlas), remote hosts, mixed host lists and
 * unparsable values all return false. It never logs or returns the URI.
 *
 * Used to keep tests off any remote database and to stop a production deployment
 * from being pointed at a local MongoDB.
 */
function isLocalMongoUri(uri) {
  if (typeof uri !== 'string') return false;
  const match = /^mongodb:\/\/([^/?#]*)/i.exec(uri.trim());
  if (!match) return false;

  let authority = match[1];
  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1); // drop user:password@
  if (!authority) return false;

  return authority.split(',').every((hostPort) => {
    let host = hostPort;
    if (host.startsWith('[')) {
      const end = host.indexOf(']');
      if (end === -1) return false;
      host = host.slice(0, end + 1);
    } else {
      host = host.split(':')[0];
    }
    return LOCAL_HOSTS.has(host.toLowerCase());
  });
}

module.exports = { isLocalMongoUri };
