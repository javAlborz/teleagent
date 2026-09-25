/**
 * Voice Interface Application
 * Main entry point - v9 with Multi-Extension + Device API Support
 */

var mediaRuntimeModule = require("../lib/media-receiver-runtime");
var hostStartGeneration = null;
if (process.env.NODE_ENV !== 'production') require("dotenv").config();
var voiceAppRuntimeContract = require("../lib/voice-app-runtime-env");
var mediaReceiverRuntime = null;
var fixedRuntimeEnvironment = null;
try {
  fixedRuntimeEnvironment = voiceAppRuntimeContract.assertVoiceAppRuntimeEnvironment(process.env);
  hostStartGeneration = mediaRuntimeModule.awaitHostStart();
  mediaReceiverRuntime = mediaRuntimeModule.loadMediaReceiverRuntime();
  if (mediaReceiverRuntime.generation !== hostStartGeneration) {
    throw new Error('host start generation differs from independent media admission');
  }
  var voiceEgressRuntime = require("../lib/voice-egress-runtime").loadVoiceEgressRuntime(mediaReceiverRuntime);
  require("./lib/voice-egress-transport").configureVoiceEgress(voiceEgressRuntime);
  require("./lib/media-playback-urls").configureMediaPlayback(mediaReceiverRuntime);
} catch (error) {
  console.error("[CONFIG] Voice state/listener boundary failed: " + error.message);
  process.exit(1);
}
var Srf = require("drachtio-srf");
var Mrf = require("drachtio-fsmrf");

// Import application modules
var httpServerModule = require("./lib/http-server");
var createHttpServer = httpServerModule.createHttpServer;
var cleanupOldFiles = httpServerModule.cleanupOldFiles;
var createIsolatedMediaHttp = require("./lib/isolated-media-http").createIsolatedMediaHttp;
var mediaStartupFence = require("./lib/isolated-media-http").createMediaStartupFence();
var audioForkModule = require("./lib/audio-fork");
var assertAudioForkDebugSafe = audioForkModule.assertAudioForkDebugSafe;
var AudioForkServer = audioForkModule.AudioForkServer;
var normalizeAudioForkServerOptions = audioForkModule.normalizeAudioForkServerOptions;
var sipHandler = require("./lib/sip-handler");
var handleInvite = sipHandler.handleInvite;
var InboundCallRegistry = require("./lib/inbound-call-registry").InboundCallRegistry;
var whisperClient = require("./lib/whisper-client");
var claudeBridge = require("./lib/claude-bridge");
var ttsService = require("./lib/tts-service");
var voiceRuntimeState = require("./lib/voice-runtime-state");
var openVoiceRuntimeState = voiceRuntimeState.openVoiceRuntimeState;
var releaseVoiceRuntimeFenceAfterShutdown = voiceRuntimeState.releaseVoiceRuntimeFenceAfterShutdown;
var OutboundRuntimeFence = require("./lib/outbound-runtime-fence").OutboundRuntimeFence;
var AgentJobBroker = require("./lib/agent-job-broker").AgentJobBroker;
var VoiceExecutionControl = require("../lib/voice-execution-control").VoiceExecutionControl;
var voiceControlRoutes = require("./lib/voice-control-routes");
var createVoiceControlRouter = voiceControlRoutes.createVoiceControlRouter;
var loadVoiceControlAuthConfig = voiceControlRoutes.loadVoiceControlAuthConfig;
var requireLoopback = voiceControlRoutes.requireLoopback;
var realtimeClientConfig = require("./lib/openai-realtime-client");
var getRealtimeApiKey = realtimeClientConfig.getRealtimeApiKey;
var loadRealtimeEndpointConfig = realtimeClientConfig.loadRealtimeEndpointConfig;
var queueRuntimeCallback = require("./lib/conversation-loop").queueRuntimeCallback;
var refreshRuntimeTranscriptionVocabulary = require("./lib/realtime-conversation").refreshRuntimeTranscriptionVocabulary;
var loadSipTrunkSecurityConfig = require("./lib/sip-trunk-auth").loadSipTrunkSecurityConfig;
var mediaControlEndpoints = require("./lib/media-control-endpoints");
var buildFreeswitchConnectionOptions = mediaControlEndpoints.buildFreeswitchConnectionOptions;
var loadMediaControlEndpoints = mediaControlEndpoints.loadMediaControlEndpoints;
var loadLegacySpeechConfig = require("./lib/legacy-speech-config").loadLegacySpeechConfig;
var voiceRuntimePreflight = require("./lib/voice-runtime-preflight");
var projectStateCapacityHealth = voiceRuntimePreflight.projectStateCapacityHealth;
var VoiceStateCapacityGuard = voiceRuntimePreflight.VoiceStateCapacityGuard;
var runtimeSecretsModule = require("./lib/runtime-secrets");
var configureRuntimeSecrets = runtimeSecretsModule.configureRuntimeSecrets;
var loadRuntimeSecrets = runtimeSecretsModule.loadRuntimeSecrets;

// Multi-extension support
var deviceRegistry = null;

// Connection retry utility
var connectionRetry = require("./lib/connection-retry");
var connectWithRetry = connectionRetry.connectWithRetry;

// Import outbound calling routes
var outboundModule = require("./lib/outbound-routes");
var outboundRouter = outboundModule.router;
var setupOutboundRoutes = outboundModule.setupRoutes;
var shutdownOutboundCalls = outboundModule.shutdownOutboundCalls;

// Import device routes
var deviceRouter = require("./lib/device-routes");

// Load device registry first
// deviceRegistry is a singleton, already instantiated

// Configuration
var config = {
  drachtio: {
    host: null,
    port: null,
    secret: null
  },
  freeswitch: {
    host: null,
    port: null,
    secret: null
  },
  http_host: fixedRuntimeEnvironment.httpHost,
  http_port: parseInt(process.env.HTTP_PORT) || 3000,
  ws_host: fixedRuntimeEnvironment.wsHost,
  ws_connect_host: fixedRuntimeEnvironment.wsConnectHost,
  ws_non_loopback_enabled: fixedRuntimeEnvironment.wsNonLoopbackEnabled,
  ws_allowed_peers: fixedRuntimeEnvironment.wsAllowedPeers,
  ws_port: parseInt(process.env.WS_PORT) || 3001,
  audio_dir: process.env.AUDIO_DIR || "/tmp/voice-audio",
  voice_state_db_path: fixedRuntimeEnvironment.stateDbPath,
  voice_execution_lock_path: fixedRuntimeEnvironment.executionLockFile,
  approval_capability: Object.freeze({
    enabled: false,
    issuer: null,
    status: "blocked_pending_independent_pbx_attester"
  }),
  privileged_actions: Object.freeze({
    enabled: false,
    apiToken: null,
    status: "blocked_pending_controller_owned_approval_authority"
  })
};

try {
  config.media_endpoints = loadMediaControlEndpoints(process.env, mediaReceiverRuntime);
  var receiverProjection = mediaReceiverRuntime.projection;
  config.http_host = receiverProjection.controlHttp.host;
  config.http_port = receiverProjection.controlHttp.port;
  config.ws_host = receiverProjection.audioForkOptions.host;
  config.ws_connect_host = receiverProjection.audioForkOptions.connectHost;
  config.ws_port = receiverProjection.audioForkOptions.port;
  config.ws_non_loopback_enabled = receiverProjection.audioForkOptions.allowNonLoopback;
  config.ws_allowed_peers = receiverProjection.audioForkOptions.allowedPeers;
  config.legacy_speech = loadLegacySpeechConfig(process.env);
  if (config.legacy_speech.enabled !== voiceEgressRuntime.speechEnabled) {
    throw new Error("Legacy speech differs from independent egress admission");
  }
  config.realtime_endpoint = loadRealtimeEndpointConfig(process.env);
  config.drachtio.host = config.media_endpoints.drachtio.host;
  config.drachtio.port = config.media_endpoints.drachtio.port;
  config.freeswitch.host = config.media_endpoints.freeswitch.host;
  config.freeswitch.port = config.media_endpoints.freeswitch.port;
  config.runtime_secrets = configureRuntimeSecrets(loadRuntimeSecrets());
  assertAudioForkDebugSafe(process.env.DEBUG);
  config.audio_fork = normalizeAudioForkServerOptions({
    port: config.ws_port,
    host: config.ws_host,
    connectHost: config.ws_connect_host,
    allowNonLoopback: config.ws_non_loopback_enabled,
    allowedPeers: config.ws_allowed_peers
  });
} catch (error) {
  console.error("[CONFIG] Voice runtime setup failed: " + error.message);
  process.exit(1);
}

// Voice is not an approval authority. It must never load a signing key or a
// privileged controller bearer. Mutating, target-session, and privileged jobs
// remain fail closed until an independent PBX attester and controller-owned
// approval authority are implemented.
try {
  config.drachtio.secret = config.runtime_secrets.drachtioSecret;
  config.freeswitch.secret = config.runtime_secrets.freeswitchSecret;
  config.voice_control_auth = loadVoiceControlAuthConfig({
    runtimeSecrets: config.runtime_secrets,
  });
  config.sip_trunk_security = loadSipTrunkSecurityConfig();
  config.outbound_routing = config.sip_trunk_security.outboundRouting;
} catch (error) {
  console.error("[CONFIG] Voice authorization setup failed: " + error.message);
  process.exit(1);
}

// devices.json is persona/routing metadata only. Load it only after the
// credential/config gates above, still before constructing any SIP client.
// A legacy authId/password/authPassword field is a fatal migration error.
try {
  deviceRegistry = require("./lib/device-registry");
} catch (error) {
  console.error("[CONFIG] Device routing setup failed: " + error.message);
  process.exit(1);
}

// Initialize drachtio SRF
var srf = new Srf();
var mediaServer = null;
var httpServer = null;
var isolatedMediaHttp = null;
var audioForkServer = null;
var drachtioConnected = false;
var freeswitchConnected = false;
var voiceStateStore = null;
var stateCapacityGuard = null;
var agentJobBroker = null;
var outboundRuntimeFence = null;
var inboundCallRegistry = new InboundCallRegistry();

// Log startup
console.log("\n" + "=".repeat(64));
console.log("          Voice Interface Application Starting                 ");
console.log("       (with Multi-Extension + Device API Support)             ");
console.log("=".repeat(64));
console.log("\nConfiguration:");
console.log("  - drachtio:    " + config.drachtio.host + ":" + config.drachtio.port);
console.log("  - FreeSWITCH:  " + config.freeswitch.host + ":" + config.freeswitch.port);
console.log("  - HTTP API:    " + config.http_host + ":" + config.http_port);
console.log("  - WS Audio:    " + config.ws_host + ":" + config.ws_port);
console.log("  - WS Peer:     " + config.ws_connect_host + " (one-time authenticated attach)");
console.log("  - Audio Dir:   " + config.audio_dir);
console.log("  - Voice State: " + config.voice_state_db_path);
console.log("  - Voice Lock:  " + config.voice_execution_lock_path);
console.log("  - Signed approvals: " + (config.approval_capability.enabled
  ? "enabled"
  : "disabled (mutating voice jobs blocked)"));
  console.log("  - Privileged actions: " + (config.privileged_actions.enabled
    ? "enabled through authenticated host controller"
    : "disabled"));
  console.log("  - SIP trunks: mutually authenticated");
console.log("  - Audio Fork:  mono (caller audio only; bidirectional playout enabled)");
console.log("\n[DEVICES] Loaded " + Object.keys(deviceRegistry.getAllDevices()).length + " device extensions");
console.log("\nWaiting for connections...\n");

// Fence the whole voice process before it registers SIP devices, connects a
// media worker, opens state, or reconciles interrupted work. A replacement may
// start only after the old process and all of those planes have stopped.
stateCapacityGuard = new VoiceStateCapacityGuard();
var startupCapacityHealth = stateCapacityGuard.check();
if (!startupCapacityHealth.ok) {
  console.error("[CONFIG] Durable voice state capacity boundary is unavailable");
  process.exit(1);
}
outboundRuntimeFence = new OutboundRuntimeFence({
  stateDbPath: config.voice_state_db_path
});

// Connect to drachtio
srf.connect({
  host: config.drachtio.host,
  port: config.drachtio.port,
  secret: config.drachtio.secret
});

srf.on("connect", function(err, hostport) {
  console.log("[" + new Date().toISOString() + "] DRACHTIO Connected at " + hostport);
  drachtioConnected = true;

  checkReadyState();
});

srf.on("error", function(err) {
  console.error("[" + new Date().toISOString() + "] DRACHTIO error: " + err.message);
  drachtioConnected = false;
});

// Initialize FreeSWITCH MRF with retry logic
var mrf = new Mrf(srf);

// Define FreeSWITCH connection function
function connectToFreeswitch() {
  return mrf.connect(buildFreeswitchConnectionOptions(
    config.freeswitch,
    config.freeswitch.secret,
    mediaReceiverRuntime
  ));
}

// Connect with exponential backoff retry
// Retry schedule: 1s, 2s, 3s, 5s, 5s, 5s, 10s, 10s, 10s, 10s (max 10 retries)
connectWithRetry(connectToFreeswitch, {
  maxRetries: 10,
  retryDelays: [1000, 2000, 3000, 5000, 5000, 5000, 10000, 10000, 10000, 10000],
  name: 'FREESWITCH'
})
.then(function(ms) {
  mediaServer = ms;
  freeswitchConnected = true;
  console.log("[" + new Date().toISOString() + "] FREESWITCH Ready for calls");
  checkReadyState();
})
.catch(function(err) {
  console.error("[" + new Date().toISOString() + "] FREESWITCH Connection failed permanently: " + err.message);
  console.error("[" + new Date().toISOString() + "] Please check:");
  console.error("  1. FreeSWITCH container is running: docker ps | grep freeswitch");
  console.error("  2. ESL port 8021 is accessible");
  process.exit(1);
});

// Initialize servers
async function initializeServers(assertStartupActive) {
  assertStartupActive();
  var fs = require("fs");
  if (!fs.existsSync(config.audio_dir)) {
    fs.mkdirSync(config.audio_dir, { recursive: true });
  }

  var initialCapacityHealth = stateCapacityGuard.check();
  if (!initialCapacityHealth.ok) {
    throw new Error("Durable voice state capacity boundary is unavailable");
  }
  var runtimeState = openVoiceRuntimeState({
    dbPath: config.voice_state_db_path,
    runtimeFence: outboundRuntimeFence
  });
  voiceStateStore = runtimeState.stateStore;
  var voiceExecutionControl = new VoiceExecutionControl({ lockFile: config.voice_execution_lock_path });
  agentJobBroker = new AgentJobBroker({
    stateStore: voiceStateStore,
    agentBridge: claudeBridge,
    executionControl: voiceExecutionControl,
    approvalCapabilityIssuer: null,
    privilegedActionBridge: null,
    outboundControl: outboundModule,
    callbackDispatcher: async function(job, thread, delivery) {
      if (!thread || !thread.callback_target) {
        return { queued: false, reason: "missing_callback_target" };
      }
      return queueRuntimeCallback({
        target: thread.callback_target,
        message: job.voice_result || job.error || "Your agent task finished.",
        mode: "realtime",
        deviceName: "OpenAI Realtime",
        callUuid: job.id,
        transcript: job.request,
        reason: "realtime_agent_job_complete",
        voiceThreadId: job.voice_thread_id,
        idempotencyKey: delivery && delivery.idempotencyKey
      });
    }
  });
  var recoveredJobCount = agentJobBroker.recoverDurableJobs();
  if (recoveredJobCount > 0) {
    console.log("[AGENT] Resuming " + recoveredJobCount + " durable job(s) after restart");
  }
  // Warm dynamic names in the background so Realtime call setup never waits on Hermes inspection.
  void refreshRuntimeTranscriptionVocabulary(claudeBridge);

  // HTTP server for TTS audio
  httpServer = createHttpServer(config.audio_dir, config.http_port, config.http_host);
  console.log("[" + new Date().toISOString() + "] HTTP Server started on " + config.http_host + ":" + config.http_port);
  isolatedMediaHttp = createIsolatedMediaHttp(mediaReceiverRuntime, {
    audioDir: config.audio_dir,
    staticDir: require("node:path").join(__dirname, "static")
  });
  isolatedMediaHttp.server.on("error", function() { void shutdown("MEDIA_HTTP_FAILURE"); });
  await isolatedMediaHttp.ready;
  assertStartupActive();

  // WebSocket server for audio fork
  audioForkServer = new AudioForkServer(config.audio_fork);
  audioForkServer.start();
  audioForkServer.on("listening", function() {
    console.log("[" + new Date().toISOString() + "] WEBSOCKET Audio fork server started on " + config.ws_host + ":" + config.ws_port);
  });
  audioForkServer.on("session", function(session) {
    console.log("[AUDIO] New session for call " + session.callUuid);
  });

  // TTS service
  ttsService.setAudioDir(config.audio_dir);
  console.log("[" + new Date().toISOString() + "] TTS Service configured");

  // ========== OUTBOUND CALLING ROUTES ==========
  setupOutboundRoutes({
    srf: srf,
    mediaServer: mediaServer,
    deviceRegistry: deviceRegistry,  // Required for device lookup
    audioForkServer: audioForkServer,
    whisperClient: whisperClient,
    claudeBridge: claudeBridge,
    ttsService: ttsService,
    voiceStateStore: voiceStateStore,
    agentJobBroker: agentJobBroker,
    runtimeFence: outboundRuntimeFence,
    stateCapacityGuard: stateCapacityGuard,
    routingConfig: config.outbound_routing,
    wsPort: config.ws_port,
    httpHost: config.http_host
  });

  httpServer.app.use("/api", outboundRouter);
  console.log("[" + new Date().toISOString() + "] OUTBOUND Calling API enabled");

  // ========== DEVICE API ROUTES ==========
  httpServer.app.use("/api", deviceRouter);
  console.log("[" + new Date().toISOString() + "] DEVICE API enabled (/api/devices, /api/device/:identifier)");

  httpServer.app.use("/api", createVoiceControlRouter({
    jobBroker: agentJobBroker,
    agentBridge: claudeBridge,
    voiceControlAuth: config.voice_control_auth
  }));
  console.log("[" + new Date().toISOString() + "] VOICE CONTROL API enabled (/api/voice-control/*)");

  httpServer.app.get("/api/realtime-health", requireLoopback, function(req, res) {
    var stateHealth = voiceStateStore.health();
    var capacityHealth = stateCapacityGuard.check();
    var publicCapacityHealth = projectStateCapacityHealth(capacityHealth);
    var executionHealth = agentJobBroker.getExecutionLock();
    var healthy = stateHealth.ok === true && publicCapacityHealth.ok;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "healthy" : "unhealthy",
      configured: !!getRealtimeApiKey(),
      model: config.realtime_endpoint.model,
      approvalCapabilities: {
        enabled: config.approval_capability.enabled,
        mutatingVoiceJobs: "blocked",
        status: config.approval_capability.status
      },
      privilegedActions: {
        enabled: config.privileged_actions.enabled,
        boundary: "unavailable_to_voice",
        status: config.privileged_actions.status
      },
      voiceExecution: {
        locked: executionHealth.locked,
        persistent: executionHealth.persistent,
        remotePanicPending: executionHealth.remotePanicPending
      },
      state: {
        ...stateHealth,
        capacity: publicCapacityHealth
      }
    });
  });

  // Finalize HTTP server
  httpServer.finalize();

  // Cleanup old files periodically
  setInterval(function() {
    cleanupOldFiles(config.audio_dir, 5 * 60 * 1000);
  }, 60 * 1000);
}

// Check ready state
async function checkReadyState() {
  if (drachtioConnected && freeswitchConnected) {
    try {
      await mediaStartupFence.run(initializeServers, function() {
        // Register SIP INVITE handler
        srf.invite(function(req, res) {
          // Authenticate the Asterisk trunk before the call enters the active-call
          // registry or any caller/thread/media/approval state is created.
          var inboundAdmission = config.sip_trunk_security.inboundAuthenticator
            .authenticateInvite(req, res);
          if (!inboundAdmission) return;
          void inboundCallRegistry.dispatch(req, res, function(inboundOperation) {
            return handleInvite(req, res, {
              audioForkServer: audioForkServer,
              mediaServer: mediaServer,
              deviceRegistry: deviceRegistry,
              config: config,
              whisperClient: whisperClient,
              claudeBridge: claudeBridge,
              ttsService: ttsService,
              voiceStateStore: voiceStateStore,
              agentJobBroker: agentJobBroker,
              wsPort: config.ws_port,
              inboundTrunkAuthenticator: config.sip_trunk_security.inboundAuthenticator,
              inboundAdmission: inboundAdmission,
              stateCapacityGuard: stateCapacityGuard,
              signal: inboundOperation.signal,
              onResources: inboundOperation.onResources
            });
          }).catch(function(err) {
            console.error("[" + new Date().toISOString() + "] CALL Error: " + err.message);
          });
        });
        inboundCallRegistry.startAccepting();

        console.log("\n[" + new Date().toISOString() + "] READY Voice interface is fully connected!");
        console.log("=".repeat(64) + "\n");
        console.log("[" + new Date().toISOString() + "] SIP INVITE handler registered");
        console.log("[" + new Date().toISOString() + "] Multi-extension voice interface ready!");
      });
    } catch { await shutdown("MEDIA_STARTUP_FAILURE"); }
  }
}

// Graceful shutdown
var shutdownPromise = null;
function shutdown(signal) {
  mediaStartupFence.stop();
  require("./lib/voice-egress-transport").stopVoiceEgress();
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async function() {
    console.log("\n[" + new Date().toISOString() + "] Received " + signal + ", shutting down...");
    // Close SIP admission before the first await so a drain-racing INVITE is
    // either already tracked or synchronously rejected without media/provider
    // work.
    inboundCallRegistry.stopAccepting();
    var forceExitTimer = setTimeout(function() {
      console.error("[SHUTDOWN] Timed out waiting for durable voice work to quiesce");
      process.exit(1);
    }, 20000);
    forceExitTimer.unref?.();

    // Trigger every work-plane interruption immediately. Listener
    // teardown must not delay aborting an already active inbound/provider call.
    var brokerDrainPromise = agentJobBroker
      ? agentJobBroker.shutdown({ timeoutMs: 10000 })
      : Promise.resolve({ safeToClose: true, drained: true, activeCount: 0 });
    var outboundDrainPromise = shutdownOutboundCalls({ timeoutMs: 10000 });
    var inboundDrainPromise = inboundCallRegistry.shutdown({
      reason: "Voice application shutdown",
      timeoutMs: 10000
    });

    var httpClosed = new Promise(function(resolve) {
      if (!httpServer || !httpServer.server) return resolve(true);
      httpServer.server.close(function() { resolve(true); });
    });
    var isolatedMediaClosed = isolatedMediaHttp ? isolatedMediaHttp.close() : Promise.resolve(true);
    var audioForkClosed = Promise.resolve(true);
    if (audioForkServer?.wss) {
      var audioForkListener = audioForkServer.wss;
      audioForkClosed = new Promise(function(resolve) {
        audioForkListener.once("close", function() { resolve(true); });
      });
    }
    if (audioForkServer) audioForkServer.stop();

    var drainResults = await Promise.all([
      brokerDrainPromise,
      outboundDrainPromise,
      inboundDrainPromise
    ]);
    var brokerDrain = drainResults[0];
    var outboundDrain = drainResults[1];
    var inboundDrain = drainResults[2];
    var transportClosures = await Promise.all([
      Promise.race([
        Promise.all([httpClosed, isolatedMediaClosed]).then(function(values) { return values.every(Boolean); }),
        new Promise(function(resolve) { setTimeout(function() { resolve(false); }, 2000); })
      ]),
      Promise.race([
        audioForkClosed,
        new Promise(function(resolve) { setTimeout(function() { resolve(false); }, 2000); })
      ])
    ]);
    var httpCloseConfirmed = transportClosures[0];
    var audioForkCloseConfirmed = transportClosures[1];
    if (mediaServer) await Promise.resolve(mediaServer.disconnect());
    if (srf) srf.disconnect();
    var safeToCloseState = brokerDrain.safeToClose && outboundDrain.safeToClose &&
      inboundDrain.safeToClose &&
      httpCloseConfirmed && audioForkCloseConfirmed;
    if (voiceStateStore && safeToCloseState) {
      voiceStateStore.close();
    } else if (!safeToCloseState) {
      console.error("[SHUTDOWN] Voice planes did not fully drain; leaving SQLite and the owner fence open until process exit", {
        broker: brokerDrain,
        outbound: outboundDrain,
        inbound: inboundDrain,
        httpCloseConfirmed: httpCloseConfirmed,
        audioForkCloseConfirmed: audioForkCloseConfirmed
      });
    }
    var runtimeRelease = releaseVoiceRuntimeFenceAfterShutdown({
      runtimeFence: outboundRuntimeFence,
      stateStore: voiceStateStore,
      brokerDrain: brokerDrain,
      outboundDrain: outboundDrain,
      inboundDrain: inboundDrain,
      transportsClosed: httpCloseConfirmed && audioForkCloseConfirmed
    });
    if (runtimeRelease.released) {
      outboundRuntimeFence = null;
    }
    clearTimeout(forceExitTimer);
    process.exit(safeToCloseState ? 0 : 1);
  })().catch(function(error) {
    console.error("[SHUTDOWN] Graceful shutdown failed", error);
    process.exit(1);
  });
  return shutdownPromise;
}

process.on("SIGTERM", function() { void shutdown("SIGTERM"); });
process.on("SIGINT", function() { void shutdown("SIGINT"); });
