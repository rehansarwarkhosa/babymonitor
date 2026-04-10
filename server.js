const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

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

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static(path.join(__dirname, "public")));
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
  [path.join(RECORDINGS_DIR, "_temp"), path.join(SCREENSHOTS_DIR, "_temp")].forEach((tempDir) => {
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
