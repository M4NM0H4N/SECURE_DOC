'use strict';

const fs = require('fs');
const path = require('path');
const { StorageError, assertKey } = require('./errors');

// Files under one private folder (UPLOAD_DIR), never served statically. Used in development,
// tests and single-server deployments with a persistent disk.
class LocalAdapter {
  constructor(root) {
    this.root = path.resolve(root);
    this.name = 'local';
  }

  // Validated key -> absolute path, and a second check that it really is inside the root.
  resolve(key) {
    assertKey(key);
    const full = path.resolve(this.root, ...key.split('/'));
    if (!full.startsWith(this.root + path.sep)) throw new StorageError('INVALID_KEY', 'Invalid storage key');
    return full;
  }

  async put(key, buffer) {
    const full = this.resolve(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, buffer, { flag: 'wx', mode: 0o600 });
  }

  // Resolves with { stream, size } only if the file can be read, so a missing file is a clean
  // 404 before any response header is sent.
  async get(key) {
    const full = this.resolve(key);
    let stat;
    try {
      stat = await fs.promises.stat(full);
      await fs.promises.access(full, fs.constants.R_OK);
    } catch (err) {
      throw new StorageError(err.code === 'ENOENT' ? 'NOT_FOUND' : 'FAILED', 'Stored file is not available');
    }
    return { stream: fs.createReadStream(full), size: stat.size };
  }

  async exists(key) {
    try {
      await fs.promises.access(this.resolve(key), fs.constants.R_OK);
      return true;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      return false;
    }
  }

  async delete(key) {
    try {
      await fs.promises.unlink(this.resolve(key));
    } catch (err) {
      if (err instanceof StorageError) throw err;
      /* already gone */
    }
  }

  // Every file under the root: [{ key, size, modifiedAt }]. Keys that do not follow the current
  // layout (files from before S4) are returned as they are, so the cleanup script can see them.
  async list() {
    const out = [];
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (_err) {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          const stat = await fs.promises.stat(full);
          out.push({ key: path.relative(this.root, full).split(path.sep).join('/'), size: stat.size, modifiedAt: stat.mtime });
        }
      }
    };
    await walk(this.root);
    return out;
  }

  // Start-up check: the folder exists and is writable.
  async check() {
    await fs.promises.mkdir(this.root, { recursive: true });
    await fs.promises.access(this.root, fs.constants.W_OK);
  }

  // Raw delete for the cleanup script (legacy keys do not match the current layout).
  async deleteRaw(key) {
    const full = path.resolve(this.root, ...String(key).split('/'));
    if (!full.startsWith(this.root + path.sep)) throw new StorageError('INVALID_KEY', 'Invalid storage key');
    await fs.promises.unlink(full).catch(() => {});
  }
}

module.exports = LocalAdapter;
