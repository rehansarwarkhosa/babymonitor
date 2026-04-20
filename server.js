const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
let ffmpegPath = null;
try { ffmpegPath = require("ffmpeg-static"); } catch (e) { /* optional */ }

const app = express();
const server = http.createServer(app);

// Timeouts for slow-network (30-minute) uploads
server.timeout = 30 * 60 * 1000;
server.keepAliveTimeout = 30 * 60 * 1000;
server.headersTimeout = 31 * 60 * 1000;

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 500 * 1024 * 1024, // 500 MB for socket messages
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
});

const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
const GALLERY_DIR = path.join(__dirname, "gallery");
const APK_DIR = path.join(__dirname, "apk");
const FAVORITES_FILE = path.join(__dirname, "favorites.json");
const AUTH_FILE = path.join(__dirname, "auth.json");
const NOTES_FILE = path.join(__dirname, "notes.json");

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}
if (!fs.existsSync(GALLERY_DIR)) {
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
}
if (!fs.existsSync(APK_DIR)) {
  fs.mkdirSync(APK_DIR, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.set("etag", false);

// Extended timeout for slow-network uploads (30 minutes)
app.use((req, res, next) => {
  req.setTimeout(30 * 60 * 1000);
  res.setTimeout(30 * 60 * 1000);
  next();
});

// Multer config — save to temp first, then move to device folder
const ALLOWED_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".webm",
  ".3gp",
  ".aac",
];
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

// Use memory storage temporarily, then save to correct folder
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Save to temp folder first - we'll move it after we have deviceId
    const tempDir = path.join(RECORDINGS_DIR, "_temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    // Add timestamp to prevent conflicts
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    cb(null, `${basename}_${timestamp}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
        ),
      );
    }
  },
});

// Screenshot upload multer config
const screenshotStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempDir = path.join(SCREENSHOTS_DIR, "_temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    cb(null, `${basename}_${timestamp}${ext}`);
  },
});

const screenshotUpload = multer({
  storage: screenshotStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed for screenshots"));
    }
  },
});

// Gallery image upload multer config
const galleryStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempDir = path.join(GALLERY_DIR, "_temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    cb(null, `${basename}_${timestamp}${ext}`);
  },
});

const galleryUpload = multer({
  storage: galleryStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed for gallery"));
    }
  },
});

// In-memory gallery image metadata store
const galleryImages = new Map(); // deviceId -> [{ imageId, originalName, filename, folderName, dateTaken, size, requestId, uploadedAt }]

// State
const devices = new Map();
const serverStartTime = Date.now();

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const getDevicesSnapshot = () => {
  const result = {};
  devices.forEach((dev, id) => {
    result[id] = { ...dev };
  });
  return result;
};

const broadcastDevices = () => {
  io.emit("devices_update", getDevicesSnapshot());
};

// ─── AUTHENTICATION ─────────────────────────────────────────

const hashPassword = (p) =>
  crypto.createHash("sha256").update(String(p)).digest("hex");

function loadAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (!a.passwordHash) a.passwordHash = hashPassword("2412");
    if (typeof a.enabled !== "boolean") a.enabled = true;
    if (!a.sessionTimeoutMinutes || a.sessionTimeoutMinutes < 1)
      a.sessionTimeoutMinutes = 5;
    if (typeof a.requireDeletePassword !== "boolean") a.requireDeletePassword = true;
    if (typeof a.lockDelete !== "boolean") a.lockDelete = false;
    return a;
  } catch {
    const def = {
      enabled: true,
      passwordHash: hashPassword("2412"),
      sessionTimeoutMinutes: 5,
      requireDeletePassword: true,
      lockDelete: false,
    };
    try { fs.writeFileSync(AUTH_FILE, JSON.stringify(def, null, 2)); } catch {}
    return def;
  }
}
function saveAuth(a) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2));
}

// token -> { expiresAt }
const sessions = new Map();

function touchSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return s;
}
function createSession() {
  const token = crypto.randomBytes(24).toString("hex");
  const auth = loadAuth();
  const expiresAt = Date.now() + auth.sessionTimeoutMinutes * 60000;
  sessions.set(token, { expiresAt });
  return { token, expiresAt, sessionTimeoutMinutes: auth.sessionTimeoutMinutes };
}
function getReqToken(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1];
  if (req.query && req.query.token) return req.query.token;
  const cookie = req.headers.cookie || "";
  const cm = /(?:^|;\s*)auth_token=([^;]+)/.exec(cookie);
  if (cm) { try { return decodeURIComponent(cm[1]); } catch { return cm[1]; } }
  return null;
}
function isValidToken(token) {
  if (!token) return false;
  return !!touchSession(token);
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, t) => { if (now > s.expiresAt) sessions.delete(t); });
}, 60000);

function requireAuth(req, res, next) {
  const auth = loadAuth();
  if (!auth.enabled) return next();
  if (isValidToken(getReqToken(req))) return next();
  return res.status(401).json({ error: "Unauthorized", code: "AUTH_REQUIRED" });
}

// Public auth endpoints
app.get("/api/auth/status", (req, res) => {
  const a = loadAuth();
  const token = getReqToken(req);
  const valid = isValidToken(token);
  const s = valid ? sessions.get(token) : null;
  res.json({
    enabled: a.enabled,
    sessionTimeoutMinutes: a.sessionTimeoutMinutes,
    requireDeletePassword: a.requireDeletePassword,
    lockDelete: a.lockDelete,
    authenticated: !a.enabled || valid,
    expiresAt: s ? s.expiresAt : null,
    extended: s ? !!s.extended : false,
  });
});

// Verify password without issuing a new session (used for in-app confirmations).
app.post("/api/auth/verify", (req, res) => {
  const { password } = req.body || {};
  const a = loadAuth();
  if (hashPassword(password || "") !== a.passwordHash) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  res.json({ success: true });
});

// Extend the current session to an absolute window (default 2 hours).
app.post("/api/auth/extend", (req, res) => {
  const { password, hours } = req.body || {};
  const a = loadAuth();
  if (hashPassword(password || "") !== a.passwordHash) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  const token = getReqToken(req);
  const s = token ? sessions.get(token) : null;
  if (!s) return res.status(401).json({ error: "No active session" });
  const h = Math.min(24, Math.max(1, Number(hours) || 2));
  s.expiresAt = Date.now() + h * 3600000;
  s.extended = true;
  res.json({ expiresAt: s.expiresAt, extended: true, hours: h });
});

app.post("/api/auth/login", (req, res) => {
  const { password } = req.body || {};
  const a = loadAuth();
  if (!a.enabled) {
    const s = createSession();
    return res.json(s);
  }
  if (hashPassword(password || "") !== a.passwordHash) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const s = createSession();
  res.json(s);
});

app.post("/api/auth/logout", (req, res) => {
  const token = getReqToken(req);
  if (token) sessions.delete(token);
  res.json({ success: true });
});

app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const { current, next: newPass } = req.body || {};
  const a = loadAuth();
  if (hashPassword(current || "") !== a.passwordHash) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  const np = String(newPass || "");
  if (!/^\d{4,12}$/.test(np)) {
    return res.status(400).json({ error: "Password must be 4–12 digits" });
  }
  a.passwordHash = hashPassword(np);
  saveAuth(a);
  sessions.clear();
  res.json({ success: true });
});

app.post("/api/auth/settings", requireAuth, (req, res) => {
  const { sessionTimeoutMinutes, enabled, requireDeletePassword, lockDelete } = req.body || {};
  const a = loadAuth();
  if (sessionTimeoutMinutes !== undefined) {
    const n = Math.floor(Number(sessionTimeoutMinutes));
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      return res.status(400).json({ error: "Timeout must be 1–1440 minutes" });
    }
    a.sessionTimeoutMinutes = n;
  }
  if (typeof enabled === "boolean") a.enabled = enabled;
  if (typeof requireDeletePassword === "boolean") a.requireDeletePassword = requireDeletePassword;
  if (typeof lockDelete === "boolean") a.lockDelete = lockDelete;
  saveAuth(a);
  res.json({
    enabled: a.enabled,
    sessionTimeoutMinutes: a.sessionTimeoutMinutes,
    requireDeletePassword: a.requireDeletePassword,
    lockDelete: a.lockDelete,
  });
});

// NOTE: Auth is intentionally client-side only (login gate + session timeout in the UI).
// HTTP routes and Socket.io remain OPEN so the Android app and existing clients keep working.
// The requireAuth middleware is still used to protect the password/settings-change endpoints.

// ─── REST API ───────────────────────────────────────────────

// Upload endpoint - FIXED VERSION
app.post("/upload", upload.single("audio"), (req, res) => {
  try {
    // Check for multer errors
    if (!req.file) {
      log("Upload error: No audio file provided");
      return res
        .status(400)
        .json({ error: "No audio file provided", code: "NO_FILE" });
    }

    // Now we have access to req.body fields
    const deviceId = req.body.deviceId || req.body.device || "unknown";
    const deviceName = req.body.deviceName || "Unknown";
    const model = req.body.model || "";

    log(
      `Processing upload from ${deviceName} (${deviceId}): ${req.file.originalname}`,
    );

    // Create device folder if it doesn't exist
    const deviceDir = path.join(RECORDINGS_DIR, deviceId);
    if (!fs.existsSync(deviceDir)) {
      fs.mkdirSync(deviceDir, { recursive: true });
      log(`Created device folder: ${deviceDir}`);
    }

    // Move file from temp to device folder
    const tempPath = req.file.path;
    const finalFilename = req.file.originalname || req.file.filename;
    const finalPath = path.join(deviceDir, finalFilename);

    // If file with same name exists, add timestamp
    let actualFinalPath = finalPath;
    if (fs.existsSync(finalPath)) {
      const ext = path.extname(finalFilename);
      const basename = path.basename(finalFilename, ext);
      actualFinalPath = path.join(deviceDir, `${basename}_${Date.now()}${ext}`);
    }

    // Move the file
    fs.renameSync(tempPath, actualFinalPath);

    const finalFilenameActual = path.basename(actualFinalPath);
    const stats = fs.statSync(actualFinalPath);

    log(
      `Upload saved: ${deviceId}/${finalFilenameActual} (${stats.size} bytes)`,
    );

    // Update device info if device is known
    if (devices.has(deviceId)) {
      const dev = devices.get(deviceId);
      if (deviceName && deviceName !== "Unknown") {
        dev.deviceName = deviceName;
      }
      dev.isRecording = false;
    }

    // Emit new recording event to all connected dashboards
    io.emit("new_recording", {
      deviceId,
      deviceName,
      filename: finalFilenameActual,
      size: stats.size,
      created: new Date().toISOString(),
    });

    // Send success response
    res.set({
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });

    return res.status(200).json({
      success: true,
      filename: finalFilenameActual,
      size: stats.size,
      deviceId: deviceId,
    });
  } catch (error) {
    log(`Upload error: ${error.message}`);
    console.error(error);

    // Clean up temp file if it exists
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    return res.status(500).json({
      error: error.message || "Upload failed",
      code: "UPLOAD_ERROR",
    });
  }
});

// Error handler for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      log("Upload rejected: file too large");
      return res
        .status(413)
        .json({ error: "File too large", code: "FILE_TOO_LARGE" });
    }
    log(`Multer error: ${err.message}`);
    return res.status(400).json({ error: err.message, code: "MULTER_ERROR" });
  }

  if (err) {
    log(`Server error: ${err.message}`);
    return res.status(500).json({ error: err.message, code: "SERVER_ERROR" });
  }

  next();
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// List all devices
app.get("/devices", (req, res) => {
  res.json(getDevicesSnapshot());
});

// Rename a device
app.post("/devices/:deviceId/rename", (req, res) => {
  const { deviceId } = req.params;
  const { newName } = req.body;

  if (!newName) {
    return res.status(400).json({ error: "newName is required" });
  }

  if (devices.has(deviceId)) {
    devices.get(deviceId).deviceName = newName;
    const dev = devices.get(deviceId);
    if (dev.isOnline && dev.socketId) {
      io.to(dev.socketId).emit("update_device_name", {
        targetDeviceId: deviceId,
        newName,
      });
    }
    broadcastDevices();
    return res.json({ success: true });
  } else {
    return res.status(404).json({ error: "Device not found" });
  }
});

// List recordings grouped by device
app.get("/recordings", (req, res) => {
  try {
    if (!fs.existsSync(RECORDINGS_DIR)) {
      return res.json({});
    }

    const result = {};
    const entries = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      // Skip temp folder
      if (entry.name === "_temp") continue;

      if (entry.isDirectory()) {
        const deviceId = entry.name;
        const deviceDir = path.join(RECORDINGS_DIR, deviceId);
        const dev = devices.get(deviceId);

        let files;
        try {
          files = fs
            .readdirSync(deviceDir)
            .filter((f) => !f.startsWith("."))
            .map((filename) => {
              const filePath = path.join(deviceDir, filename);
              const stats = fs.statSync(filePath);
              return {
                filename,
                size: stats.size,
                created: stats.birthtime || stats.mtime,
                url: `/recordings/${encodeURIComponent(deviceId)}/${encodeURIComponent(filename)}`,
              };
            })
            .sort((a, b) => new Date(b.created) - new Date(a.created));
        } catch (e) {
          log(`Error reading device folder ${deviceId}: ${e.message}`);
          files = [];
        }

        if (files.length > 0) {
          result[deviceId] = {
            deviceName: dev ? dev.deviceName : deviceId,
            recordings: files,
          };
        }
      } else if (!entry.name.startsWith(".")) {
        // Legacy flat files
        const filePath = path.join(RECORDINGS_DIR, entry.name);
        try {
          const stats = fs.statSync(filePath);
          if (!result["legacy"]) {
            result["legacy"] = { deviceName: "Unknown Device", recordings: [] };
          }
          result["legacy"].recordings.push({
            filename: entry.name,
            size: stats.size,
            created: stats.birthtime || stats.mtime,
            url: `/recordings/${encodeURIComponent(entry.name)}`,
          });
        } catch (e) {
          // Skip files we can't read
        }
      }
    }

    if (result["legacy"]) {
      result["legacy"].recordings.sort(
        (a, b) => new Date(b.created) - new Date(a.created),
      );
    }

    return res.json(result);
  } catch (err) {
    log(`Error listing recordings: ${err.message}`);
    return res.status(500).json({ error: "Failed to list recordings" });
  }
});

// Serve recording file
app.get("/recordings/:deviceIdOrFile/:filename?", (req, res) => {
  try {
    let filePath;
    if (req.params.filename) {
      filePath = path.join(
        RECORDINGS_DIR,
        req.params.deviceIdOrFile,
        req.params.filename,
      );
    } else {
      filePath = path.join(RECORDINGS_DIR, req.params.deviceIdOrFile);
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Recording not found" });
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".m4a": "audio/mp4",
      ".ogg": "audio/ogg",
      ".webm": "audio/webm",
      ".3gp": "audio/3gpp",
      ".aac": "audio/aac",
    };
    res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
    return res.sendFile(filePath);
  } catch (err) {
    log(`Error serving recording: ${err.message}`);
    return res.status(500).json({ error: "Failed to serve recording" });
  }
});

// Delete a recording
app.delete("/recordings/:deviceId/:filename", (req, res) => {
  try {
    const filePath = path.join(
      RECORDINGS_DIR,
      req.params.deviceId,
      req.params.filename,
    );
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Recording not found" });
    }
    fs.unlinkSync(filePath);
    log(`Recording deleted: ${req.params.deviceId}/${req.params.filename}`);
    return res.json({ success: true });
  } catch (err) {
    log(`Delete error: ${err.message}`);
    return res.status(500).json({ error: "Failed to delete recording" });
  }
});

// Enhance a recording with noise cancellation (offline, FFmpeg afftdn chain)
// Produces a new sibling file with "NC-" prefix that shows up as an independent item.
const enhanceJobs = new Map(); // key: `${deviceId}/${filename}` -> { status, pct }

app.post("/api/recordings/:deviceId/:filename/enhance", (req, res) => {
  try {
    if (!ffmpegPath) {
      return res.status(500).json({ error: "ffmpeg not available on server (run npm install)" });
    }
    const deviceId = req.params.deviceId;
    const filename = req.params.filename;
    if (filename.includes("/") || filename.includes("\\") || filename.startsWith(".")) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    if (filename.startsWith("NC-")) {
      return res.status(400).json({ error: "Already an enhanced file" });
    }
    const deviceDir = path.join(RECORDINGS_DIR, deviceId);
    const inputPath = path.join(deviceDir, filename);
    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ error: "Recording not found" });
    }
    const outFilename = "NC-" + filename;
    const outputPath = path.join(deviceDir, outFilename);
    if (fs.existsSync(outputPath)) {
      return res.json({ success: true, filename: outFilename, alreadyExists: true });
    }

    const jobKey = `${deviceId}/${filename}`;
    if (enhanceJobs.has(jobKey)) {
      return res.status(409).json({ error: "Enhancement already in progress" });
    }

    // Strength: 0..100 (default 70). Higher = more aggressive denoise, stronger normalization.
    const strength = Math.max(0, Math.min(100, Number(req.body?.strength) || 70));
    const nr = 12 + (strength / 100) * 25;          // 12..37
    const nf = -30 + (strength / 100) * 15;         // -30..-15 dB noise floor
    const hp = 80 + (strength / 100) * 100;         // 80..180 Hz
    const lp = 7000;                                // keep intelligibility up to 7k
    const speechE = (6 + (strength / 100) * 8).toFixed(1); // 6..14 dB expansion

    // Filter chain:
    //  highpass (kill sub-bass rumble) →
    //  2× afftdn (FFT spectral denoise, two passes for stubborn constant hum) →
    //  lowpass (trim high-freq hiss) →
    //  speechnorm (gentle, slow expansion — loudens soft voice without pumping) →
    //  acompressor (tame peaks) →
    //  loudnorm (final EBU R128 normalization)
    const filterChain =
      `highpass=f=${hp.toFixed(0)},` +
      `afftdn=nr=${nr.toFixed(1)}:nf=${nf.toFixed(1)}:nt=w:om=o,` +
      `afftdn=nr=${nr.toFixed(1)}:nf=${nf.toFixed(1)}:nt=w:om=o,` +
      `lowpass=f=${lp},` +
      `speechnorm=e=${speechE}:r=0.0001:l=1,` +
      `acompressor=threshold=-22dB:ratio=3:attack=5:release=80,` +
      `loudnorm=I=-16:TP=-1.5:LRA=11`;

    enhanceJobs.set(jobKey, { status: "running", started: Date.now() });

    const args = [
      "-y",
      "-i", inputPath,
      "-af", filterChain,
      "-ac", "1",
      "-ar", "44100",
      "-codec:a", "libmp3lame",
      "-qscale:a", "3",
      outputPath,
    ];
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrBuf = "";
    child.stderr.on("data", (d) => { stderrBuf += d.toString(); if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-10000); });
    child.on("error", (err) => {
      enhanceJobs.delete(jobKey);
      log(`Enhance spawn error: ${err.message}`);
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
      if (!res.headersSent) res.status(500).json({ error: "FFmpeg failed to start" });
    });
    child.on("close", (code) => {
      enhanceJobs.delete(jobKey);
      if (code !== 0) {
        log(`Enhance failed (code ${code}) for ${jobKey}: ${stderrBuf.slice(-500)}`);
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        if (!res.headersSent) return res.status(500).json({ error: "Enhancement failed" });
        return;
      }
      log(`Enhance ok: ${jobKey} → ${outFilename}`);
      io.emit("recording_enhanced", { deviceId, original: filename, filename: outFilename });
      if (!res.headersSent) return res.json({ success: true, filename: outFilename });
    });
  } catch (err) {
    log(`Enhance error: ${err.message}`);
    return res.status(500).json({ error: "Failed to enhance recording" });
  }
});

// Server status
app.get("/status", (req, res) => {
  res.json({
    devices: getDevicesSnapshot(),
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
  });
});

// ─── SCREENSHOT ENDPOINTS ──────────────────────────────────

// Upload screenshot from Android
app.post("/upload-screenshot", screenshotUpload.single("screenshot"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No screenshot file provided" });
    }

    const deviceId = req.body.deviceId || "unknown";
    const deviceName = req.body.deviceName || "Unknown";
    const model = req.body.model || "";
    const timestamp = req.body.timestamp || "";

    // ── GALLERY REROUTE FIX ──────────────────────────────────
    // If the Android upload queue sends a gallery image to the screenshot
    // endpoint after reconnection, detect it by gallery-specific body fields
    // and save to gallery instead.
    const isGalleryImage = req.body.imageId || req.body.folderName ||
      (req.body.requestId && req.body.requestId.startsWith("gallery_"));

    if (isGalleryImage) {
      log(`REROUTE: Gallery image received on /upload-screenshot from ${deviceName} (${deviceId}): ${req.file.originalname} — saving to gallery`);

      const galleryDeviceDir = path.join(GALLERY_DIR, deviceId);
      if (!fs.existsSync(galleryDeviceDir)) {
        fs.mkdirSync(galleryDeviceDir, { recursive: true });
      }

      const tempPath = req.file.path;
      const finalFilename = req.file.filename;
      const actualFinalPath = path.join(galleryDeviceDir, finalFilename);

      fs.renameSync(tempPath, actualFinalPath);
      const stats = fs.statSync(actualFinalPath);

      log(`Gallery image (rerouted) saved: ${deviceId}/${finalFilename} (${stats.size} bytes)`);

      // Store metadata in memory
      if (!galleryImages.has(deviceId)) {
        galleryImages.set(deviceId, []);
      }
      galleryImages.get(deviceId).push({
        deviceId,
        deviceName,
        imageId: req.body.imageId,
        originalName: req.body.originalName || req.file.originalname,
        filename: finalFilename,
        folderName: req.body.folderName || "Unknown",
        dateTaken: req.body.dateTaken ? new Date(parseInt(req.body.dateTaken)) : new Date(),
        size: parseInt(req.body.fileSize) || stats.size,
        requestId: req.body.requestId || "",
        uploadedAt: new Date(),
      });

      // Emit as gallery, NOT screenshot
      io.emit("gallery_image_received", {
        deviceId,
        deviceName,
        imageId: req.body.imageId,
        originalName: req.body.originalName || req.file.originalname,
        folderName: req.body.folderName || "Unknown",
        filename: finalFilename,
        requestId: req.body.requestId || "",
      });

      return res.status(200).json({
        success: true,
        filename: finalFilename,
        size: stats.size,
        deviceId,
        rerouted: "gallery",
      });
    }
    // ── END GALLERY REROUTE FIX ──────────────────────────────

    log(`Processing screenshot from ${deviceName} (${deviceId}): ${req.file.originalname}`);

    const deviceDir = path.join(SCREENSHOTS_DIR, deviceId);
    if (!fs.existsSync(deviceDir)) {
      fs.mkdirSync(deviceDir, { recursive: true });
    }

    const tempPath = req.file.path;
    const finalFilename = req.file.originalname || req.file.filename;
    let actualFinalPath = path.join(deviceDir, finalFilename);

    if (fs.existsSync(actualFinalPath)) {
      const ext = path.extname(finalFilename);
      const basename = path.basename(finalFilename, ext);
      actualFinalPath = path.join(deviceDir, `${basename}_${Date.now()}${ext}`);
    }

    fs.renameSync(tempPath, actualFinalPath);
    const finalFilenameActual = path.basename(actualFinalPath);
    const stats = fs.statSync(actualFinalPath);

    log(`Screenshot saved: ${deviceId}/${finalFilenameActual} (${stats.size} bytes)`);

    io.emit("screenshot_received", {
      deviceId,
      deviceName,
      filename: finalFilenameActual,
      size: stats.size,
      timestamp: timestamp ? new Date(parseInt(timestamp)).toISOString() : new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      filename: finalFilenameActual,
      size: stats.size,
      deviceId,
    });
  } catch (error) {
    log(`Screenshot upload error: ${error.message}`);
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    return res.status(500).json({ error: error.message });
  }
});

// List all screenshots grouped by device
app.get("/api/screenshots", (req, res) => {
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) return res.json({});
    const result = {};
    const entries = fs.readdirSync(SCREENSHOTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "_temp" || !entry.isDirectory()) continue;
      const deviceId = entry.name;
      const deviceDir = path.join(SCREENSHOTS_DIR, deviceId);
      const dev = devices.get(deviceId);
      try {
        const files = fs.readdirSync(deviceDir)
          .filter(f => !f.startsWith("."))
          .map(filename => {
            const filePath = path.join(deviceDir, filename);
            const stats = fs.statSync(filePath);
            return {
              filename,
              size: stats.size,
              created: stats.birthtime || stats.mtime,
              url: `/api/screenshots/image/${encodeURIComponent(deviceId)}/${encodeURIComponent(filename)}`,
            };
          })
          .sort((a, b) => new Date(b.created) - new Date(a.created));
        if (files.length > 0) {
          result[deviceId] = {
            deviceName: dev ? dev.deviceName : deviceId,
            screenshots: files,
          };
        }
      } catch (e) {
        log(`Error reading screenshot folder ${deviceId}: ${e.message}`);
      }
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: "Failed to list screenshots" });
  }
});

// Get screenshots for specific device
app.get("/api/screenshots/:deviceId", (req, res) => {
  try {
    const deviceDir = path.join(SCREENSHOTS_DIR, req.params.deviceId);
    if (!fs.existsSync(deviceDir)) return res.json([]);
    const files = fs.readdirSync(deviceDir)
      .filter(f => !f.startsWith("."))
      .map(filename => {
        const filePath = path.join(deviceDir, filename);
        const stats = fs.statSync(filePath);
        return {
          filename,
          size: stats.size,
          created: stats.birthtime || stats.mtime,
          url: `/api/screenshots/image/${encodeURIComponent(req.params.deviceId)}/${encodeURIComponent(filename)}`,
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    return res.json(files);
  } catch (err) {
    return res.status(500).json({ error: "Failed to list screenshots" });
  }
});

// Serve screenshot image file
app.get("/api/screenshots/image/:deviceId/:filename", (req, res) => {
  const filePath = path.join(SCREENSHOTS_DIR, req.params.deviceId, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Screenshot not found" });
  }
  return res.sendFile(filePath);
});

// Delete screenshot
app.delete("/api/screenshots/:deviceId/:filename", (req, res) => {
  try {
    const filePath = path.join(SCREENSHOTS_DIR, req.params.deviceId, req.params.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Screenshot not found" });
    }
    fs.unlinkSync(filePath);
    log(`Screenshot deleted: ${req.params.deviceId}/${req.params.filename}`);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete screenshot" });
  }
});

// Command device to take screenshot via REST
app.post("/api/devices/:deviceId/screenshot", (req, res) => {
  const dev = devices.get(req.params.deviceId);
  if (dev && dev.isOnline && dev.socketId) {
    io.to(dev.socketId).emit("take_screenshot", {
      targetDeviceId: req.params.deviceId,
    });
    res.json({ success: true, message: "Screenshot command sent" });
  } else {
    res.status(404).json({ error: "Device not found or offline" });
  }
});

// Get upload queue status for a specific device
app.get("/api/devices/:deviceId/queue-status", (req, res) => {
  const dev = devices.get(req.params.deviceId);
  if (dev) {
    res.json({
      deviceId: dev.deviceId,
      deviceName: dev.deviceName,
      pendingUploads: dev.pendingUploads || 0,
      uploadQueueStatus: dev.uploadQueueStatus || {},
      lastSeen: dev.lastSeen,
    });
  } else {
    res.status(404).json({ error: "Device not found" });
  }
});

// Get upload queue status for all devices
app.get("/api/devices/queue-status", (req, res) => {
  const statuses = [];
  devices.forEach((dev) => {
    statuses.push({
      deviceId: dev.deviceId,
      deviceName: dev.deviceName,
      isOnline: dev.isOnline,
      pendingUploads: dev.pendingUploads || 0,
      uploadQueueStatus: dev.uploadQueueStatus || {},
      lastSeen: dev.lastSeen,
    });
  });
  res.json(statuses);
});

// Get audio config for a device
app.get("/api/devices/:deviceId/audio-config", (req, res) => {
  const dev = devices.get(req.params.deviceId);
  if (dev) {
    res.json({
      deviceId: dev.deviceId,
      deviceName: dev.deviceName,
      audioSourceConfig: dev.audioSourceConfig || {},
      audioTestResults: dev.audioTestResults || {},
      autoDetectedSource: dev.autoDetectedSource || "not_tested",
      manufacturer: dev.manufacturer,
      model: dev.model,
    });
  } else {
    res.status(404).json({ error: "Device not found" });
  }
});

// Set audio source for a device
app.post("/api/devices/:deviceId/audio-source", (req, res) => {
  const { source } = req.body;
  const dev = devices.get(req.params.deviceId);
  if (dev && dev.isOnline && dev.socketId) {
    io.to(dev.socketId).emit("set_audio_source", {
      targetDeviceId: req.params.deviceId,
      source,
    });
    res.json({ success: true, message: `Audio source set to ${source}` });
  } else {
    res.status(404).json({ error: "Device not found or offline" });
  }
});

// Request audio source test for a device
app.post("/api/devices/:deviceId/test-audio", (req, res) => {
  const dev = devices.get(req.params.deviceId);
  if (dev && dev.isOnline && dev.socketId) {
    io.to(dev.socketId).emit("test_audio_sources", {
      targetDeviceId: req.params.deviceId,
    });
    res.json({ success: true, message: "Audio test started" });
  } else {
    res.status(404).json({ error: "Device not found or offline" });
  }
});

// Get device capabilities
app.get("/api/devices/:deviceId/capabilities", (req, res) => {
  const dev = devices.get(req.params.deviceId);
  if (dev) {
    res.json({
      audio: dev.capabilities?.audio ?? true,
      screenshot: dev.capabilities?.screenshot ?? false,
      screenshotMethod: dev.screenshotCapability || dev.capabilities?.screenshotMethod || "none",
      isScreenLocked: dev.isScreenLocked ?? false,
      notificationsEnabled: dev.notificationsEnabled ?? true,
    });
  } else {
    res.status(404).json({ error: "Device not found" });
  }
});

// ─── GALLERY IMAGE ENDPOINTS ──────────────────────────────

// Upload gallery image from Android
app.post("/upload-gallery", galleryUpload.single("gallery_image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No gallery image provided" });
    }

    const deviceId = req.body.deviceId || "unknown";
    const deviceName = req.body.deviceName || "Unknown";
    const imageId = req.body.imageId;
    const originalName = req.body.originalName || req.file.originalname;
    const dateTaken = req.body.dateTaken;
    const folderName = req.body.folderName || "Unknown";
    const fileSize = req.body.fileSize;
    const requestId = req.body.requestId || "";

    log(`Gallery image received from ${deviceName} (${deviceId}): ${originalName} (${folderName})`);

    const deviceDir = path.join(GALLERY_DIR, deviceId);
    if (!fs.existsSync(deviceDir)) {
      fs.mkdirSync(deviceDir, { recursive: true });
    }

    const tempPath = req.file.path;
    const finalFilename = req.file.filename;
    const actualFinalPath = path.join(deviceDir, finalFilename);

    fs.renameSync(tempPath, actualFinalPath);
    const stats = fs.statSync(actualFinalPath);

    log(`Gallery image saved: ${deviceId}/${finalFilename} (${stats.size} bytes)`);

    // Store metadata in memory
    if (!galleryImages.has(deviceId)) {
      galleryImages.set(deviceId, []);
    }
    const galleryImage = {
      deviceId,
      deviceName,
      imageId,
      originalName,
      filename: finalFilename,
      folderName,
      dateTaken: dateTaken ? new Date(parseInt(dateTaken)) : new Date(),
      size: parseInt(fileSize) || stats.size,
      requestId,
      uploadedAt: new Date(),
    };
    galleryImages.get(deviceId).push(galleryImage);

    // Emit to web clients
    io.emit("gallery_image_received", {
      deviceId,
      deviceName,
      imageId,
      originalName,
      folderName,
      filename: finalFilename,
      requestId,
    });

    return res.json({ success: true, filename: finalFilename });
  } catch (error) {
    log(`Gallery upload error: ${error.message}`);
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Serve gallery image file
app.get("/api/gallery/image/:deviceId/:filename", (req, res) => {
  const filePath = path.join(GALLERY_DIR, req.params.deviceId, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Image not found" });
  }
  return res.sendFile(filePath);
});

// List all gallery images grouped by device (from filesystem)
app.get("/api/gallery", (req, res) => {
  try {
    if (!fs.existsSync(GALLERY_DIR)) return res.json({});
    const result = {};
    const entries = fs.readdirSync(GALLERY_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "_temp" || !entry.isDirectory()) continue;
      const deviceId = entry.name;
      const deviceDir = path.join(GALLERY_DIR, deviceId);
      const dev = devices.get(deviceId);
      try {
        const files = fs.readdirSync(deviceDir)
          .filter(f => !f.startsWith("."))
          .map(filename => {
            const filePath = path.join(deviceDir, filename);
            const stats = fs.statSync(filePath);
            // Try to find metadata from in-memory store
            const meta = (galleryImages.get(deviceId) || []).find(m => m.filename === filename);
            return {
              filename,
              originalName: meta ? meta.originalName : filename,
              folderName: meta ? meta.folderName : "Unknown",
              dateTaken: meta ? meta.dateTaken : null,
              size: stats.size,
              created: stats.birthtime || stats.mtime,
              url: `/api/gallery/image/${encodeURIComponent(deviceId)}/${encodeURIComponent(filename)}`,
            };
          })
          .sort((a, b) => new Date(b.created) - new Date(a.created));
        if (files.length > 0) {
          result[deviceId] = {
            deviceName: dev ? dev.deviceName : deviceId,
            images: files,
          };
        }
      } catch (e) {
        log(`Error reading gallery folder ${deviceId}: ${e.message}`);
      }
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: "Failed to list gallery" });
  }
});

// Get gallery images for a specific device
app.get("/api/gallery/:deviceId", (req, res) => {
  try {
    const deviceDir = path.join(GALLERY_DIR, req.params.deviceId);
    if (!fs.existsSync(deviceDir)) return res.json([]);
    const files = fs.readdirSync(deviceDir)
      .filter(f => !f.startsWith("."))
      .map(filename => {
        const filePath = path.join(deviceDir, filename);
        const stats = fs.statSync(filePath);
        const meta = (galleryImages.get(req.params.deviceId) || []).find(m => m.filename === filename);
        return {
          filename,
          originalName: meta ? meta.originalName : filename,
          folderName: meta ? meta.folderName : "Unknown",
          dateTaken: meta ? meta.dateTaken : null,
          size: stats.size,
          created: stats.birthtime || stats.mtime,
          url: `/api/gallery/image/${encodeURIComponent(req.params.deviceId)}/${encodeURIComponent(filename)}`,
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    return res.json(files);
  } catch (err) {
    return res.status(500).json({ error: "Failed to list gallery images" });
  }
});

// Delete a gallery image
app.delete("/api/gallery/:deviceId/:filename", (req, res) => {
  try {
    const filePath = path.join(GALLERY_DIR, req.params.deviceId, req.params.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Gallery image not found" });
    }
    fs.unlinkSync(filePath);
    // Remove from in-memory store
    if (galleryImages.has(req.params.deviceId)) {
      const arr = galleryImages.get(req.params.deviceId);
      const idx = arr.findIndex(m => m.filename === req.params.filename);
      if (idx !== -1) arr.splice(idx, 1);
    }
    log(`Gallery image deleted: ${req.params.deviceId}/${req.params.filename}`);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete gallery image" });
  }
});

// Command device to get gallery stats
app.post("/api/devices/:deviceId/gallery/stats", (req, res) => {
  const dev = devices.get(req.params.deviceId);
  if (dev && dev.isOnline && dev.socketId) {
    io.to(dev.socketId).emit("get_gallery_stats", {
      targetDeviceId: req.params.deviceId,
    });
    res.json({ success: true, message: "Stats request sent" });
  } else {
    res.status(404).json({ error: "Device not found or offline" });
  }
});

// Command device to get latest images
app.post("/api/devices/:deviceId/gallery/latest", (req, res) => {
  const { count = 10, upload = false } = req.body;
  const dev = devices.get(req.params.deviceId);
  if (dev && dev.isOnline && dev.socketId) {
    const requestId = `req_${Date.now()}`;
    io.to(dev.socketId).emit("get_latest_images", {
      targetDeviceId: req.params.deviceId,
      count,
      upload,
      requestId,
    });
    res.json({ success: true, requestId });
  } else {
    res.status(404).json({ error: "Device not found or offline" });
  }
});

// Command device to get images by date range
app.post("/api/devices/:deviceId/gallery/by-date", (req, res) => {
  const { fromDate, toDate, upload = false, maxCount = 50 } = req.body;
  const dev = devices.get(req.params.deviceId);
  if (dev && dev.isOnline && dev.socketId) {
    const requestId = `req_${Date.now()}`;
    io.to(dev.socketId).emit("get_images_by_date", {
      targetDeviceId: req.params.deviceId,
      fromDate,
      toDate,
      upload,
      maxCount,
      requestId,
    });
    res.json({ success: true, requestId });
  } else {
    res.status(404).json({ error: "Device not found or offline" });
  }
});

// Flexible gallery query - combine all filters
app.post("/api/devices/:deviceId/gallery/query", (req, res) => {
  const { count = 50, fromDate, toDate, folders, onlyMetadata = false } = req.body;
  const dev = devices.get(req.params.deviceId);
  if (dev && dev.isOnline && dev.socketId) {
    const requestId = `req_${Date.now()}`;
    io.to(dev.socketId).emit("get_gallery_images", {
      targetDeviceId: req.params.deviceId,
      count,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      folders: folders || undefined,
      onlyMetadata,
      requestId,
    });
    res.json({ success: true, requestId });
  } else {
    res.status(404).json({ error: "Device not found or offline" });
  }
});

// Command device to get images by folder
app.post("/api/devices/:deviceId/gallery/by-folder", (req, res) => {
  const { folder = "camera", count = 20, upload = false } = req.body;
  const dev = devices.get(req.params.deviceId);
  if (dev && dev.isOnline && dev.socketId) {
    const requestId = `req_${Date.now()}`;
    io.to(dev.socketId).emit("get_images_by_folder", {
      targetDeviceId: req.params.deviceId,
      folder,
      count,
      upload,
      requestId,
    });
    res.json({ success: true, requestId });
  } else {
    res.status(404).json({ error: "Device not found or offline" });
  }
});

// Command device to upload specific images by ID
app.post("/api/devices/:deviceId/gallery/upload", (req, res) => {
  const { imageIds } = req.body;
  const dev = devices.get(req.params.deviceId);
  if (!imageIds || !Array.isArray(imageIds)) {
    return res.status(400).json({ error: "imageIds array required" });
  }
  if (dev && dev.isOnline && dev.socketId) {
    const requestId = `req_${Date.now()}`;
    io.to(dev.socketId).emit("upload_gallery_images", {
      targetDeviceId: req.params.deviceId,
      imageIds,
      requestId,
    });
    res.json({ success: true, requestId, imagesRequested: imageIds.length });
  } else {
    res.status(404).json({ error: "Device not found or offline" });
  }
});

// ─── BULK DELETE per device ──────────────────────────────

// Helper to delete all files in a directory
function deleteAllInDir(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  try {
    const files = fs.readdirSync(dir).filter(f => !f.startsWith("."));
    files.forEach(f => {
      try { fs.unlinkSync(path.join(dir, f)); count++; } catch (e) {}
    });
  } catch (e) {}
  return count;
}

// Delete all recordings for a device
app.delete("/api/recordings/:deviceId", (req, res) => {
  try {
    const dir = path.join(RECORDINGS_DIR, req.params.deviceId);
    const count = deleteAllInDir(dir);
    log(`Deleted all recordings for ${req.params.deviceId}: ${count} files`);
    return res.json({ success: true, deleted: count });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete recordings" });
  }
});

// Delete all screenshots for a device
app.delete("/api/screenshots/:deviceId", (req, res) => {
  try {
    const dir = path.join(SCREENSHOTS_DIR, req.params.deviceId);
    const count = deleteAllInDir(dir);
    log(`Deleted all screenshots for ${req.params.deviceId}: ${count} files`);
    return res.json({ success: true, deleted: count });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete screenshots" });
  }
});

// Delete all gallery images for a device
app.delete("/api/gallery/:deviceId", (req, res) => {
  try {
    const dir = path.join(GALLERY_DIR, req.params.deviceId);
    const count = deleteAllInDir(dir);
    galleryImages.delete(req.params.deviceId);
    log(`Deleted all gallery images for ${req.params.deviceId}: ${count} files`);
    return res.json({ success: true, deleted: count });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete gallery images" });
  }
});

// ─── DEVICE DELETE (offline only) ─────────────────────────

app.delete("/api/devices/:deviceId", (req, res) => {
  const deviceId = req.params.deviceId;
  const dev = devices.get(deviceId);
  if (!dev) {
    return res.status(404).json({ error: "Device not found" });
  }
  if (dev.isOnline) {
    return res.status(400).json({ error: "Cannot delete an online device" });
  }

  // Delete all device data: recordings, screenshots, gallery
  const dirsToDelete = [
    path.join(RECORDINGS_DIR, deviceId),
    path.join(SCREENSHOTS_DIR, deviceId),
    path.join(GALLERY_DIR, deviceId),
  ];
  let deletedFiles = 0;
  for (const dir of dirsToDelete) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        files.forEach(f => {
          try { fs.unlinkSync(path.join(dir, f)); deletedFiles++; } catch (e) {}
        });
        fs.rmdirSync(dir);
      } catch (e) {
        log(`Error cleaning up ${dir}: ${e.message}`);
      }
    }
  }
  // Clean in-memory gallery metadata
  galleryImages.delete(deviceId);

  devices.delete(deviceId);
  log(`Device removed with all data (${deletedFiles} files): ${dev.deviceName} (${deviceId})`);
  broadcastDevices();
  return res.json({ success: true, deletedFiles });
});

// ─── FAVORITES (server-side, shared across all browsers) ────

function loadFavorites() {
  try { return JSON.parse(fs.readFileSync(FAVORITES_FILE, "utf8")); }
  catch { return {}; }
}
function saveFavorites(data) {
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(data, null, 2));
}

app.get("/api/favorites", (req, res) => {
  res.json(loadFavorites());
});

app.post("/api/favorites", (req, res) => {
  const { kind, deviceId, filename } = req.body;
  if (!kind || !deviceId || !filename) return res.status(400).json({ error: "Missing fields" });
  const favs = loadFavorites();
  if (!favs[kind]) favs[kind] = {};
  if (!favs[kind][deviceId]) favs[kind][deviceId] = [];
  if (!favs[kind][deviceId].includes(filename)) favs[kind][deviceId].push(filename);
  saveFavorites(favs);
  res.json({ success: true });
});

// ─── NOTES (description per item, server-side) ─────────────

function loadNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES_FILE, "utf8")); }
  catch { return {}; }
}
function saveNotes(data) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(data, null, 2));
}

const VALID_NOTE_KINDS = new Set(["recordings", "screenshots", "gallery"]);

app.get("/api/notes", (req, res) => {
  res.json(loadNotes());
});

app.post("/api/notes", (req, res) => {
  const { kind, deviceId, filename, note } = req.body || {};
  if (!VALID_NOTE_KINDS.has(kind) || !deviceId || !filename) {
    return res.status(400).json({ error: "Missing or invalid fields" });
  }
  const text = String(note == null ? "" : note).slice(0, 1000);
  const notes = loadNotes();
  if (!text.trim()) {
    if (notes[kind]?.[deviceId]) {
      delete notes[kind][deviceId][filename];
      if (!Object.keys(notes[kind][deviceId]).length) delete notes[kind][deviceId];
      if (!Object.keys(notes[kind]).length) delete notes[kind];
    }
  } else {
    if (!notes[kind]) notes[kind] = {};
    if (!notes[kind][deviceId]) notes[kind][deviceId] = {};
    notes[kind][deviceId][filename] = text;
  }
  saveNotes(notes);
  res.json({ success: true, note: text.trim() ? text : null });
});

app.delete("/api/notes", (req, res) => {
  const { kind, deviceId, filename } = req.body || {};
  if (!VALID_NOTE_KINDS.has(kind) || !deviceId || !filename) {
    return res.status(400).json({ error: "Missing or invalid fields" });
  }
  const notes = loadNotes();
  if (notes[kind]?.[deviceId]) {
    delete notes[kind][deviceId][filename];
    if (!Object.keys(notes[kind][deviceId]).length) delete notes[kind][deviceId];
    if (!Object.keys(notes[kind]).length) delete notes[kind];
    saveNotes(notes);
  }
  res.json({ success: true });
});

app.delete("/api/favorites", (req, res) => {
  const { kind, deviceId, filename } = req.body;
  if (!kind || !deviceId || !filename) return res.status(400).json({ error: "Missing fields" });
  const favs = loadFavorites();
  if (favs[kind]?.[deviceId]) {
    favs[kind][deviceId] = favs[kind][deviceId].filter(f => f !== filename);
    if (!favs[kind][deviceId].length) delete favs[kind][deviceId];
    if (!Object.keys(favs[kind]).length) delete favs[kind];
  }
  saveFavorites(favs);
  res.json({ success: true });
});

// ─── APK MANAGEMENT ────────────────────────────────────────

const APK_FILE = "app-debug.apk";

// Upload APK (replaces existing)
const apkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, APK_DIR),
    filename: (req, file, cb) => cb(null, APK_FILE),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB max
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith(".apk")) {
      cb(null, true);
    } else {
      cb(new Error("Only .apk files are allowed"));
    }
  },
});

app.post("/api/apk/upload", apkUpload.single("apk"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No APK file provided" });
    }
    const stats = fs.statSync(path.join(APK_DIR, APK_FILE));
    log(`APK uploaded: ${APK_FILE} (${stats.size} bytes)`);
    return res.json({
      success: true,
      filename: APK_FILE,
      size: stats.size,
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    log(`APK upload error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// Download APK
app.get("/api/apk/download", (req, res) => {
  const filePath = path.join(APK_DIR, APK_FILE);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "No APK available yet" });
  }
  res.setHeader("Content-Disposition", `attachment; filename="${APK_FILE}"`);
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  return res.sendFile(filePath);
});

// APK info (check if available + size + date)
app.get("/api/apk/info", (req, res) => {
  const filePath = path.join(APK_DIR, APK_FILE);
  if (!fs.existsSync(filePath)) {
    return res.json({ available: false });
  }
  const stats = fs.statSync(filePath);
  return res.json({
    available: true,
    filename: APK_FILE,
    size: stats.size,
    updatedAt: stats.mtime.toISOString(),
  });
});

// ─── SOCKET.IO ──────────────────────────────────────────────

const PING_INTERVAL = 30000;
const PONG_TIMEOUT = 10000;
const pendingPongs = new Map();

setInterval(() => {
  devices.forEach((dev) => {
    if (dev.isOnline && dev.socketId) {
      io.to(dev.socketId).emit("ping", {});
      const timeout = setTimeout(() => {
        if (dev.isOnline) {
          dev.isOnline = false;
          dev.isRecording = false;
          dev.lastSeen = new Date().toISOString();
          log(
            `Device timed out (no pong): ${dev.deviceName} (${dev.deviceId})`,
          );
          broadcastDevices();
        }
        pendingPongs.delete(dev.socketId);
      }, PONG_TIMEOUT);
      pendingPongs.set(dev.socketId, timeout);
    }
  });
}, PING_INTERVAL);

io.on("connection", (socket) => {
  log(`Socket connected: ${socket.id}`);

  socket.emit("devices_update", getDevicesSnapshot());

  socket.on("register", (data) => {
    try {
      const deviceId = (data && data.deviceId) || socket.id.substring(0, 8);
      const existing = devices.get(deviceId);

      devices.set(deviceId, {
        deviceId,
        deviceName:
          (data && data.deviceName) ||
          (existing && existing.deviceName) ||
          (data && data.model) ||
          "Unknown Device",
        model:
          (data && data.model) || (existing && existing.model) || "Unknown",
        manufacturer:
          (data && data.manufacturer) ||
          (existing && existing.manufacturer) ||
          "",
        androidVersion:
          (data && data.androidVersion) ||
          (existing && existing.androidVersion) ||
          "",
        sdkVersion:
          (data && data.sdkVersion) ||
          (existing && existing.sdkVersion) ||
          0,
        capabilities:
          (data && data.capabilities) ||
          (existing && existing.capabilities) ||
          {},
        isOnline: true,
        isRecording: false,
        lastSeen: new Date().toISOString(),
        socketId: socket.id,
      });

      log(
        `Device registered: ${(data && data.deviceName) || (data && data.model) || "Unknown"} (${deviceId})`,
      );
      broadcastDevices();
    } catch (e) {
      log(`Error in register: ${e.message}`);
    }
  });

  socket.on("start_recording", (data) => {
    try {
      const targetId = (data && data.targetDeviceId) || "all";
      const duration = (data && data.duration) || 300;

      if (targetId === "all") {
        devices.forEach((dev) => {
          if (dev.isOnline && dev.socketId) {
            io.to(dev.socketId).emit("start_recording", {
              targetDeviceId: dev.deviceId,
              duration,
            });
            log(
              `Start recording sent to ${dev.deviceName} (${dev.deviceId}), ${duration}s`,
            );
          }
        });
      } else {
        const dev = devices.get(targetId);
        if (!dev || !dev.isOnline) {
          socket.emit("recording_error", {
            deviceId: targetId,
            error: "Device not connected",
          });
          return;
        }
        io.to(dev.socketId).emit("start_recording", {
          targetDeviceId: targetId,
          duration,
        });
        log(
          `Start recording sent to ${dev.deviceName} (${targetId}), ${duration}s`,
        );
      }
    } catch (e) {
      log(`Error in start_recording: ${e.message}`);
    }
  });

  socket.on("stop_recording", (data) => {
    try {
      const targetId = (data && data.targetDeviceId) || "all";

      if (targetId === "all") {
        devices.forEach((dev) => {
          if (dev.isOnline && dev.socketId) {
            io.to(dev.socketId).emit("stop_recording", {
              targetDeviceId: dev.deviceId,
            });
          }
        });
        log("Stop recording sent to all devices");
      } else {
        const dev = devices.get(targetId);
        if (dev && dev.isOnline && dev.socketId) {
          io.to(dev.socketId).emit("stop_recording", {
            targetDeviceId: targetId,
          });
          log(`Stop recording sent to ${dev.deviceName} (${targetId})`);
        }
      }
    } catch (e) {
      log(`Error in stop_recording: ${e.message}`);
    }
  });

  socket.on("update_device_name", (data) => {
    try {
      const targetDeviceId = data && data.targetDeviceId;
      const newName = data && data.newName;

      if (targetDeviceId && newName && devices.has(targetDeviceId)) {
        devices.get(targetDeviceId).deviceName = newName;
        const dev = devices.get(targetDeviceId);
        if (dev.isOnline && dev.socketId) {
          io.to(dev.socketId).emit("update_device_name", {
            targetDeviceId,
            newName,
          });
        }
        broadcastDevices();
        log(`Device renamed: ${targetDeviceId} → ${newName}`);
      }
    } catch (e) {
      log(`Error in update_device_name: ${e.message}`);
    }
  });

  socket.on("recording_started", (data) => {
    try {
      const deviceId = data && data.deviceId;
      if (deviceId && devices.has(deviceId)) {
        devices.get(deviceId).isRecording = true;
        log(
          `Recording started: ${devices.get(deviceId).deviceName} (${deviceId})`,
        );
        broadcastDevices();
      }
    } catch (e) {
      log(`Error in recording_started: ${e.message}`);
    }
  });

  socket.on("recording_stopped", (data) => {
    try {
      const deviceId = data && data.deviceId;
      if (deviceId && devices.has(deviceId)) {
        devices.get(deviceId).isRecording = false;
        log(`Recording stopped: ${devices.get(deviceId).deviceName} (${deviceId})`);
        broadcastDevices();
      }
    } catch (e) {
      log(`Error in recording_stopped: ${e.message}`);
    }
  });

  socket.on("recording_error", (data) => {
    try {
      const deviceId = data && data.deviceId;
      if (deviceId && devices.has(deviceId)) {
        devices.get(deviceId).isRecording = false;
        broadcastDevices();
      }
      log(
        `Recording error on ${deviceId || "unknown"}: ${(data && data.error) || "Unknown"}`,
      );
      io.emit("recording_error", {
        deviceId: deviceId,
        deviceName: data && data.deviceName,
        error: data && data.error,
      });
    } catch (e) {
      log(`Error in recording_error handler: ${e.message}`);
    }
  });

  socket.on("upload_complete", (data) => {
    try {
      const deviceId = data && data.deviceId;
      if (deviceId && devices.has(deviceId)) {
        devices.get(deviceId).isRecording = false;
        log(
          `Upload complete from ${deviceId}: ${(data && data.filename) || ""}`,
        );
        broadcastDevices();
      }
    } catch (e) {
      log(`Error in upload_complete: ${e.message}`);
    }
  });

  socket.on("upload_error", (data) => {
    try {
      log(
        `Upload error from ${(data && data.deviceId) || "unknown"}: ${(data && data.error) || "Unknown"}`,
      );
      io.emit("upload_error", {
        deviceId: data && data.deviceId,
        deviceName: data && data.deviceName,
        error: data && data.error,
      });
    } catch (e) {
      log(`Error in upload_error handler: ${e.message}`);
    }
  });

  socket.on("upload_failed", (data) => {
    try {
      log(
        `Upload failed from ${(data && data.deviceName) || "unknown"}: ${(data && data.filename) || ""} (attempt ${(data && data.failCount) || "?"})`,
      );
      io.emit("upload_failed", {
        deviceId: data && data.deviceId,
        deviceName: data && data.deviceName,
        filename: data && data.filename,
        failCount: data && data.failCount,
        fileSize: data && data.fileSize,
      });
    } catch (e) {
      log(`Error in upload_failed handler: ${e.message}`);
    }
  });

  // ─── Audio source events from Android ─────────────────────

  socket.on("audio_source_test_started", (data) => {
    try {
      log(`Audio source test started on ${(data && data.deviceName) || "unknown"}`);
      io.emit("audio_source_test_started", data);
    } catch (e) {
      log(`Error in audio_source_test_started: ${e.message}`);
    }
  });

  socket.on("audio_source_test_complete", (data) => {
    try {
      const deviceId = data && data.deviceId;
      log(`Audio source test complete on ${(data && data.deviceName) || "unknown"} — auto-detected: ${data && data.autoDetectedSource}`);
      if (deviceId && devices.has(deviceId)) {
        const dev = devices.get(deviceId);
        dev.audioSourceConfig = {
          ...(dev.audioSourceConfig || {}),
          testResults: data.testResults,
          autoDetectedSource: data.autoDetectedSource,
          currentSource: data.currentSource,
          hasTestedSources: true,
          lastTestTime: Date.now(),
        };
        dev.audioTestResults = data.testResults;
        dev.autoDetectedSource = data.autoDetectedSource;
      }
      io.emit("audio_source_test_complete", data);
      broadcastDevices();
    } catch (e) {
      log(`Error in audio_source_test_complete: ${e.message}`);
    }
  });

  socket.on("audio_source_updated", (data) => {
    try {
      const deviceId = data && data.deviceId;
      log(`Audio source updated on ${(data && data.deviceName) || "unknown"}: ${data && data.selectedSource}`);
      if (deviceId && devices.has(deviceId)) {
        const dev = devices.get(deviceId);
        dev.audioSourceConfig = {
          ...(dev.audioSourceConfig || {}),
          userSelectedSource: data.selectedSource,
          autoDetectedSource: data.autoDetectedSource,
          currentSource: data.selectedSource === "auto" ? data.autoDetectedSource : data.selectedSource,
        };
      }
      io.emit("audio_source_updated", data);
      broadcastDevices();
    } catch (e) {
      log(`Error in audio_source_updated: ${e.message}`);
    }
  });

  socket.on("audio_source_working", (data) => {
    try {
      log(`Working audio source on ${(data && data.deviceName) || "unknown"}: ${data && data.workingSource}`);
      if (data.deviceId && devices.has(data.deviceId)) {
        const dev = devices.get(data.deviceId);
        dev.audioSourceConfig = {
          ...(dev.audioSourceConfig || {}),
          currentSource: data.workingSource,
        };
      }
      io.emit("audio_source_working", data);
    } catch (e) {
      log(`Error in audio_source_working: ${e.message}`);
    }
  });

  socket.on("audio_config", (data) => {
    try {
      const deviceId = data && data.deviceId;
      if (deviceId && devices.has(deviceId)) {
        devices.get(deviceId).audioSourceConfig = data.config;
      }
      io.emit("audio_config", data);
    } catch (e) {
      log(`Error in audio_config: ${e.message}`);
    }
  });

  socket.on("recording_interrupted", (data) => {
    try {
      log(`Recording interrupted on ${(data && data.deviceName) || "unknown"}: ${(data && data.message) || data.reason}`);
      if (data.deviceId && devices.has(data.deviceId)) {
        devices.get(data.deviceId).isRecording = false;
        broadcastDevices();
      }
      io.emit("recording_interrupted", data);
    } catch (e) {
      log(`Error in recording_interrupted: ${e.message}`);
    }
  });

  socket.on("partial_recording_saved", (data) => {
    try {
      log(`Partial recording saved from ${(data && data.deviceName) || "unknown"}: ${data && data.filename}`);
      io.emit("partial_recording_saved", data);
    } catch (e) {
      log(`Error in partial_recording_saved: ${e.message}`);
    }
  });

  socket.on("recording_retry", (data) => {
    try {
      log(`Recording retry on ${(data && data.deviceName) || "unknown"}`);
      if (data.deviceId && devices.has(data.deviceId)) {
        devices.get(data.deviceId).isRecording = true;
        broadcastDevices();
      }
      io.emit("recording_retry", data);
    } catch (e) {
      log(`Error in recording_retry: ${e.message}`);
    }
  });

  // ─── Connection health ───────────────────────────────────

  socket.on("health_check", (data) => {
    try {
      socket.emit("health_check_ack", {
        deviceId: data && data.deviceId,
        serverTime: Date.now(),
      });
    } catch (e) {
      log(`Error in health_check: ${e.message}`);
    }
  });

  // ─── Audio source commands TO Android ───────────────────

  socket.on("set_audio_source", (data) => {
    try {
      const targetId = data && data.targetDeviceId;
      const source = data && data.source;
      const dev = devices.get(targetId);
      if (dev && dev.isOnline && dev.socketId) {
        io.to(dev.socketId).emit("set_audio_source", { targetDeviceId: targetId, source });
        log(`Set audio source on ${dev.deviceName} (${targetId}): ${source}`);
      }
    } catch (e) {
      log(`Error in set_audio_source: ${e.message}`);
    }
  });

  socket.on("test_audio_sources", (data) => {
    try {
      const targetId = (data && data.targetDeviceId) || "all";
      if (targetId === "all") {
        devices.forEach((dev) => {
          if (dev.isOnline && dev.socketId) {
            io.to(dev.socketId).emit("test_audio_sources", { targetDeviceId: dev.deviceId });
            log(`Test audio sources sent to ${dev.deviceName} (${dev.deviceId})`);
          }
        });
      } else {
        const dev = devices.get(targetId);
        if (dev && dev.isOnline && dev.socketId) {
          io.to(dev.socketId).emit("test_audio_sources", { targetDeviceId: targetId });
          log(`Test audio sources sent to ${dev.deviceName} (${targetId})`);
        }
      }
    } catch (e) {
      log(`Error in test_audio_sources: ${e.message}`);
    }
  });

  socket.on("get_audio_config", (data) => {
    try {
      const targetId = data && data.targetDeviceId;
      const dev = devices.get(targetId);
      if (dev && dev.isOnline && dev.socketId) {
        io.to(dev.socketId).emit("get_audio_config", { targetDeviceId: targetId });
        log(`Get audio config sent to ${dev.deviceName} (${targetId})`);
      }
    } catch (e) {
      log(`Error in get_audio_config: ${e.message}`);
    }
  });

  // Screenshot events from Android
  socket.on("take_screenshot", (data) => {
    try {
      const targetId = (data && data.targetDeviceId) || "all";
      if (targetId === "all") {
        devices.forEach((dev) => {
          if (dev.isOnline && dev.socketId) {
            io.to(dev.socketId).emit("take_screenshot", {
              targetDeviceId: dev.deviceId,
            });
            log(`Take screenshot sent to ${dev.deviceName} (${dev.deviceId})`);
          }
        });
      } else {
        const dev = devices.get(targetId);
        if (dev && dev.isOnline && dev.socketId) {
          io.to(dev.socketId).emit("take_screenshot", {
            targetDeviceId: targetId,
          });
          log(`Take screenshot sent to ${dev.deviceName} (${targetId})`);
        }
      }
    } catch (e) {
      log(`Error in take_screenshot: ${e.message}`);
    }
  });

  socket.on("screenshot_status", (data) => {
    try {
      log(`Screenshot status from ${(data && data.deviceName) || "unknown"}: ${(data && data.status) || ""}`);
      io.emit("screenshot_status", data);
    } catch (e) {
      log(`Error in screenshot_status: ${e.message}`);
    }
  });

  socket.on("screenshot_captured", (data) => {
    try {
      log(`Screenshot captured from ${(data && data.deviceName) || "unknown"}: ${(data && data.filename) || ""}`);
      io.emit("screenshot_captured", data);
    } catch (e) {
      log(`Error in screenshot_captured: ${e.message}`);
    }
  });

  socket.on("screenshot_uploaded", (data) => {
    try {
      log(`Screenshot uploaded from ${(data && data.deviceName) || "unknown"}: ${(data && data.filename) || ""}`);
      io.emit("screenshot_uploaded", data);
    } catch (e) {
      log(`Error in screenshot_uploaded: ${e.message}`);
    }
  });

  socket.on("screenshot_error", (data) => {
    try {
      log(`Screenshot error from ${(data && data.deviceName) || "unknown"}: ${(data && data.error) || "Unknown"}`);
      io.emit("screenshot_error", data);
    } catch (e) {
      log(`Error in screenshot_error: ${e.message}`);
    }
  });

  // ─── Gallery monitoring events ──────────────────────────

  socket.on("gallery_stats", (data) => {
    try {
      log(`Gallery stats from ${(data && data.deviceName) || "unknown"}: ${JSON.stringify(data.stats || {})}`);
      io.emit("gallery_stats", data);
    } catch (e) {
      log(`Error in gallery_stats: ${e.message}`);
    }
  });

  socket.on("gallery_scan_started", (data) => {
    try {
      log(`Gallery scan started on ${(data && data.deviceId) || "unknown"}`);
      io.emit("gallery_scan_started", data);
    } catch (e) {
      log(`Error in gallery_scan_started: ${e.message}`);
    }
  });

  socket.on("gallery_metadata", (data) => {
    try {
      log(`Received metadata for ${data.totalImages} images from ${(data && data.deviceName) || "unknown"}`);
      io.emit("gallery_metadata", data);
    } catch (e) {
      log(`Error in gallery_metadata: ${e.message}`);
    }
  });

  socket.on("gallery_scan_error", (data) => {
    try {
      log(`Gallery scan error: ${(data && data.error) || "Unknown"}`);
      io.emit("gallery_scan_error", data);
    } catch (e) {
      log(`Error in gallery_scan_error: ${e.message}`);
    }
  });

  socket.on("gallery_upload_started", (data) => {
    try {
      log(`Starting upload of ${data.totalImages} gallery images`);
      io.emit("gallery_upload_started", data);
    } catch (e) {
      log(`Error in gallery_upload_started: ${e.message}`);
    }
  });

  socket.on("gallery_upload_queued", (data) => {
    try {
      log(`Queued ${data.queuedImages}/${data.totalRequested} images for upload`);
      io.emit("gallery_upload_queued", data);
    } catch (e) {
      log(`Error in gallery_upload_queued: ${e.message}`);
    }
  });

  socket.on("gallery_image_uploaded", (data) => {
    try {
      log(`Gallery image uploaded: ${(data && data.name) || ""}`);
      io.emit("gallery_image_uploaded", data);
    } catch (e) {
      log(`Error in gallery_image_uploaded: ${e.message}`);
    }
  });

  socket.on("gallery_upload_complete", (data) => {
    try {
      log(`Gallery upload complete: ${data.uploaded} uploaded, ${data.failed} failed`);
      io.emit("gallery_upload_complete", data);
    } catch (e) {
      log(`Error in gallery_upload_complete: ${e.message}`);
    }
  });

  socket.on("gallery_upload_error", (data) => {
    try {
      log(`Gallery upload error: ${(data && data.error) || "Unknown"}`);
      io.emit("gallery_upload_error", data);
    } catch (e) {
      log(`Error in gallery_upload_error: ${e.message}`);
    }
  });

  socket.on("gallery_upload_paused", (data) => {
    try {
      log(`Gallery upload paused on ${(data && data.deviceId) || "unknown"}: ${data.remaining} remaining, reason: ${data.reason}`);
      io.emit("gallery_upload_paused", data);
    } catch (e) {
      log(`Error in gallery_upload_paused: ${e.message}`);
    }
  });

  // Gallery commands TO Android
  socket.on("get_gallery_stats", (data) => {
    try {
      const targetId = data && data.targetDeviceId;
      const dev = devices.get(targetId);
      if (dev && dev.isOnline && dev.socketId) {
        io.to(dev.socketId).emit("get_gallery_stats", { targetDeviceId: targetId });
        log(`Get gallery stats sent to ${dev.deviceName} (${targetId})`);
      }
    } catch (e) {
      log(`Error in get_gallery_stats: ${e.message}`);
    }
  });

  socket.on("get_latest_images", (data) => {
    try {
      const targetId = data && data.targetDeviceId;
      const dev = devices.get(targetId);
      if (dev && dev.isOnline && dev.socketId) {
        io.to(dev.socketId).emit("get_latest_images", data);
        log(`Get latest images sent to ${dev.deviceName} (${targetId})`);
      }
    } catch (e) {
      log(`Error in get_latest_images: ${e.message}`);
    }
  });

  socket.on("get_images_by_date", (data) => {
    try {
      const targetId = data && data.targetDeviceId;
      const dev = devices.get(targetId);
      if (dev && dev.isOnline && dev.socketId) {
        io.to(dev.socketId).emit("get_images_by_date", data);
        log(`Get images by date sent to ${dev.deviceName} (${targetId})`);
      }
    } catch (e) {
      log(`Error in get_images_by_date: ${e.message}`);
    }
  });

  socket.on("get_images_by_folder", (data) => {
    try {
      const targetId = data && data.targetDeviceId;
      const dev = devices.get(targetId);
      if (dev && dev.isOnline && dev.socketId) {
        io.to(dev.socketId).emit("get_images_by_folder", data);
        log(`Get images by folder sent to ${dev.deviceName} (${targetId})`);
      }
    } catch (e) {
      log(`Error in get_images_by_folder: ${e.message}`);
    }
  });

  socket.on("get_gallery_images", (data) => {
    try {
      const targetId = data && data.targetDeviceId;
      const dev = devices.get(targetId);
      if (dev && dev.isOnline && dev.socketId) {
        io.to(dev.socketId).emit("get_gallery_images", data);
        log(`Get gallery images sent to ${dev.deviceName} (${targetId})`);
      }
    } catch (e) {
      log(`Error in get_gallery_images: ${e.message}`);
    }
  });

  socket.on("upload_gallery_images", (data) => {
    try {
      const targetId = data && data.targetDeviceId;
      const dev = devices.get(targetId);
      if (dev && dev.isOnline && dev.socketId) {
        io.to(dev.socketId).emit("upload_gallery_images", data);
        log(`Upload gallery images sent to ${dev.deviceName} (${targetId})`);
      }
    } catch (e) {
      log(`Error in upload_gallery_images: ${e.message}`);
    }
  });

  socket.on("pong", (data) => {
    try {
      const deviceId = data && data.deviceId;
      if (deviceId && devices.has(deviceId)) {
        const dev = devices.get(deviceId);
        dev.isOnline = true;
        dev.lastSeen = new Date().toISOString();
        if (data.isRecording !== undefined) dev.isRecording = data.isRecording;
        if (data.deviceName) dev.deviceName = data.deviceName;
        if (data.pendingUploads !== undefined) dev.pendingUploads = data.pendingUploads;
        if (data.notificationsEnabled !== undefined) dev.notificationsEnabled = data.notificationsEnabled;
        if (data.screenshotCapability) dev.screenshotCapability = data.screenshotCapability;
        if (data.isScreenLocked !== undefined) dev.isScreenLocked = data.isScreenLocked;
        if (data.uploadQueueStatus !== undefined) dev.uploadQueueStatus = data.uploadQueueStatus;
        if (data.audioSourceConfig !== undefined) dev.audioSourceConfig = data.audioSourceConfig;
        if (data.connectionHealthy !== undefined) dev.connectionHealthy = data.connectionHealthy;
        // Store top-level audio fields from audioSourceConfig for REST compat
        if (data.audioSourceConfig) {
          if (data.audioSourceConfig.testResults) dev.audioTestResults = data.audioSourceConfig.testResults;
          if (data.audioSourceConfig.autoDetectedSource) dev.autoDetectedSource = data.audioSourceConfig.autoDetectedSource;
        }
      }
      if (pendingPongs.has(socket.id)) {
        clearTimeout(pendingPongs.get(socket.id));
        pendingPongs.delete(socket.id);
      }
    } catch (e) {
      log(`Error in pong: ${e.message}`);
    }
  });

  socket.on("device_name_updated", (data) => {
    try {
      const deviceId = data && data.deviceId;
      if (deviceId && devices.has(deviceId)) {
        devices.get(deviceId).deviceName = data.deviceName;
        broadcastDevices();
        log(`Device name confirmed: ${deviceId} → ${data.deviceName}`);
      }
    } catch (e) {
      log(`Error in device_name_updated: ${e.message}`);
    }
  });

  socket.on("disconnect", () => {
    log(`Socket disconnected: ${socket.id}`);
    devices.forEach((dev) => {
      if (dev.socketId === socket.id) {
        dev.isOnline = false;
        dev.isRecording = false;
        dev.lastSeen = new Date().toISOString();
        dev.socketId = null;
        log(`Device offline: ${dev.deviceName} (${dev.deviceId})`);
      }
    });
    if (pendingPongs.has(socket.id)) {
      clearTimeout(pendingPongs.get(socket.id));
      pendingPongs.delete(socket.id);
    }
    broadcastDevices();
  });
});

// Clean up temp folders periodically (every hour)
setInterval(() => {
  [path.join(RECORDINGS_DIR, "_temp"), path.join(SCREENSHOTS_DIR, "_temp"), path.join(GALLERY_DIR, "_temp")].forEach((tempDir) => {
    if (fs.existsSync(tempDir)) {
      try {
        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        files.forEach((file) => {
          const filePath = path.join(tempDir, file);
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > 3600000) {
            fs.unlinkSync(filePath);
            log(`Cleaned up temp file: ${file}`);
          }
        });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
}, 3600000);

// ─── START SERVER ───────────────────────────────────────────

server.listen(PORT, () => {
  log(`Baby Monitor server running on http://localhost:${PORT}`);
});
