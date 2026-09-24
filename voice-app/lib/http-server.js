/**
 * HTTP Server for TTS Audio Delivery
 *
 * Express server that:
 * 1. Serves generated TTS audio files to FreeSWITCH
 * 2. Provides health check endpoint
 * 3. Keeps media retrieval on the local FreeSWITCH boundary
 * 4. Automatically cleans up old temporary files
 */

const express = require('express');
const path = require('path');
const fsSync = require('fs');
const fs = fsSync.promises;
const debug = require('debug')('voice-app:http-server');
const crypto = require('crypto');
const { playbackUrl } = require('./media-playback-urls');

// Cleanup interval: every 2 minutes
const CLEANUP_INTERVAL = 120000;
// File max age: 10 minutes
const FILE_MAX_AGE = 600000;
const MAX_MEDIA_FILE_BYTES = 128 * 1024 * 1024;
const MEDIA_TYPES = Object.freeze({
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pcm: 'application/octet-stream',
});

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalMediaRoot(directory, label) {
  const resolved = path.resolve(directory);
  const metadata = fsSync.lstatSync(resolved);
  const canonical = fsSync.realpathSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== resolved) {
    throw new Error(`${label} must be a canonical non-symlink directory`);
  }
  if (!fsSync.constants.O_NOFOLLOW) {
    throw new Error('The media server requires O_NOFOLLOW support');
  }
  return canonical;
}

function normalizeMediaPath(rawValue, { nested = false } = {}) {
  const value = String(rawValue || '');
  if (!value || value.length > 512 || /[\\\0\r\n]/u.test(value) || path.isAbsolute(value)) {
    return null;
  }
  const segments = value.split('/');
  if ((!nested && segments.length !== 1) ||
      segments.some((segment) => !segment || segment === '.' || segment === '..' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(segment))) {
    return null;
  }
  const extension = path.extname(value).slice(1).toLowerCase();
  if (!Object.hasOwn(MEDIA_TYPES, extension)) return null;
  return { relativePath: segments.join(path.sep), contentType: MEDIA_TYPES[extension] };
}

async function openConfinedMedia(root, rawValue, options) {
  const normalized = normalizeMediaPath(rawValue, options);
  if (!normalized) return null;
  const candidate = path.join(root, normalized.relativePath);
  let handle;
  try {
    handle = await fs.open(
      candidate,
      fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 0 || metadata.size > MAX_MEDIA_FILE_BYTES) {
      await handle.close();
      return null;
    }
    // Resolve the already-open descriptor, not the mutable pathname. This
    // closes both final-component and intermediate-directory symlink races.
    const openedPath = await fs.realpath(`/proc/self/fd/${handle.fd}`);
    if (!isWithin(root, openedPath)) {
      await handle.close();
      return null;
    }
    return { handle, metadata, contentType: normalized.contentType };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

function confinedMediaHandler(root, { nested = false, cacheControl = 'no-store' } = {}) {
  return async (req, res) => {
    const requestedPath = nested ? req.params[0] : req.params.filename;
    const opened = await openConfinedMedia(root, requestedPath, { nested });
    if (!opened) return res.status(404).json({ error: 'not_found' });

    res.status(200);
    res.setHeader('Content-Type', opened.contentType);
    res.setHeader('Content-Length', String(opened.metadata.size));
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = opened.handle.createReadStream({ autoClose: true });
    stream.once('error', (error) => {
      if (!res.headersSent) res.status(404).json({ error: 'not_found' });
      else res.destroy(error);
    });
    res.once('close', () => stream.destroy());
    stream.pipe(res);
    return undefined;
  };
}

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function requireLoopbackMedia(req, res, next) {
  if (isLoopbackAddress(req.socket?.remoteAddress)) return next();
  return res.status(403).json({ error: 'loopback_required' });
}

/**
 * Create HTTP Server
 *
 * @param {string} audioDir - Directory to serve audio files from
 * @param {number} port - Port to listen on (default: 3000)
 * @param {string} host - Host/interface to bind (default: 127.0.0.1)
 * @param {Object} options - Optional test/deployment roots
 * @returns {Object} { app, server, saveAudio, getAudioUrl, close, finalize }
 */
function createHttpServer(audioDir, port = 3000, host = '127.0.0.1', {
  staticDir = path.join(__dirname, '..', 'static'),
} = {}) {
  const app = express();
  const canonicalAudioDir = canonicalMediaRoot(audioDir, 'Generated audio directory');
  const canonicalStaticDir = canonicalMediaRoot(staticDir, 'Static media directory');

  // Parse JSON bodies
  app.use(express.json());

  // Generated and static audio are consumed by local FreeSWITCH. They may
  // contain private call content and are never part of the non-loopback API.
  app.get(
    '/audio-files/:filename',
    requireLoopbackMedia,
    confinedMediaHandler(canonicalAudioDir),
  );

  // Serve STATIC audio files (beeps, hold music) - NOT subject to cleanup
  app.get(
    /^\/static\/(.+)$/u,
    requireLoopbackMedia,
    confinedMediaHandler(canonicalStaticDir, { nested: true, cacheControl: 'private, max-age=300' }),
  );

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString()
    });
  });

  // NOTE: 404 and error handlers are added in finalize() AFTER additional routes

  // Start server
  const server = app.listen(port, host, () => {
    debug(`HTTP server listening on ${host}:${port}`);
    debug(`Serving audio files from ${audioDir}`);
  });

  // Cleanup old files periodically
  const cleanupTimer = setInterval(async () => {
    try {
      await cleanupOldFiles(audioDir, FILE_MAX_AGE);
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }, CLEANUP_INTERVAL);

  // Cleanup on server close
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    debug('Stopping HTTP server');
    clearInterval(cleanupTimer);
    originalClose(callback);
  };

  /**
   * Save audio buffer to file and return URL
   * @param {Buffer} audioBuffer - Audio data
   * @param {string} format - File format (wav, mp3)
   * @returns {Promise<string>} URL to audio file
   */
  async function saveAudio(audioBuffer, format = 'wav') {
    const normalizedFormat = String(format || '').toLowerCase();
    if (!Object.hasOwn(MEDIA_TYPES, normalizedFormat)) {
      throw new Error('Unsupported generated audio format');
    }
    const filename = `audio_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${normalizedFormat}`;
    const filepath = path.join(canonicalAudioDir, filename);

    debug(`Saving ${format} audio to ${filepath} (${audioBuffer.length} bytes)`);

    await fs.writeFile(filepath, audioBuffer, { flag: 'wx', mode: 0o600 });

    const url = playbackUrl('audio-files', filename);
    debug(`Audio saved, URL: ${url}`);

    return url;
  }

  /**
   * Get URL for a filename in audio directory
   * @param {string} filename - Name of audio file
   * @returns {string} Full URL
   */
  function getAudioUrl(filename) {
    if (!normalizeMediaPath(filename)) throw new Error('Invalid generated audio filename');
    return playbackUrl('audio-files', filename);
  }

  /**
   * Finalize the Express app by adding 404 and error handlers
   * Call this AFTER adding any additional routes
   */
  function finalize() {
    // 404 handler
    app.use((req, res) => {
      res.status(404).json({
        error: 'Not found',
        path: req.path
      });
    });

    // Error handler
    app.use((err, req, res, _next) => {
      console.error('Server error:', err);
      res.status(500).json({
        error: 'Internal server error'
      });
    });

    debug('HTTP server finalized with 404/error handlers');
  }

  return {
    app,
    server,
    saveAudio,
    getAudioUrl,
    close: () => server.close(),
    finalize
  };
}

/**
 * Cleanup files older than maxAge
 * @param {string} directory - Directory to clean
 * @param {number} maxAge - Max age in milliseconds
 */
async function cleanupOldFiles(directory, maxAge) {
  try {
    const files = await fs.readdir(directory);
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      const filepath = path.join(directory, file);

      try {
        const stats = await fs.lstat(filepath);
        if (!stats.isFile()) {
          if (stats.isSymbolicLink()) await fs.unlink(filepath);
          continue;
        }
        const age = now - stats.mtimeMs;

        if (age > maxAge) {
          debug(`Deleting old file: ${file} (age: ${Math.round(age / 1000)}s)`);
          await fs.unlink(filepath);
          deletedCount++;
        }
      } catch (error) {
        // Skip files that can't be accessed
        debug(`Error checking file ${file}:`, error.message);
      }
    }

    if (deletedCount > 0) {
      debug(`Cleanup complete: deleted ${deletedCount} old files`);
    }

  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}

module.exports = {
  createHttpServer,
  canonicalMediaRoot,
  normalizeMediaPath,
  openConfinedMedia,
  cleanupOldFiles,
  isLoopbackAddress,
  requireLoopbackMedia
};
