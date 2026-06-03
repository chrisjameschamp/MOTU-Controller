import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";
import type { AppConfig, MotuMeterLevels, MotuMeterStats, MotuTrack, NanoEvent, Profile, SerialPortInfo } from "./types";

type ConnectionState = "disconnected" | "connecting" | "connected";

const state: {
  config: AppConfig | null;
  ports: SerialPortInfo[];
  selectedPort: string;
  connection: ConnectionState;
  currentProfile: string;
  lastKnobPosition: number | null;
  expectedDeviceKnobPosition: number | null;
  lastNanoSeenAt: number;
  nanoHeartbeatMisses: number;
  ignoreKnobUntil: number;
  motuLevelsLoaded: boolean;
  motuConnectedIp: string;
  motuMeters: Record<number, number>;
  metersOnline: boolean;
  menuVisible: boolean;
  meterStreamRunning: boolean;
  meterStreamKey: string;
  meterStats: MotuMeterStats | null;
  motuTracks: MotuTrack[];
  selectedTrackChannels: Set<number>;
  newProfileName: string;
  editingProfileName: string | null;
  editName: string;
  isDiscoveringTracks: boolean;
  isApplyingKnob: boolean;
  builderOpen: boolean;
  settingsOpen: boolean;
  startOnLogin: boolean;
  consoleExpanded: boolean;
  savedConfigSnapshot: string;
  log: string[];
} = {
  config: null,
  ports: [],
  selectedPort: "",
  connection: "disconnected",
  currentProfile: "",
  lastKnobPosition: null,
  expectedDeviceKnobPosition: null,
  lastNanoSeenAt: 0,
  nanoHeartbeatMisses: 0,
  ignoreKnobUntil: 0,
  motuLevelsLoaded: false,
  motuConnectedIp: "",
  motuMeters: {},
  metersOnline: false,
  menuVisible: false,
  meterStreamRunning: false,
  meterStreamKey: "",
  meterStats: null,
  motuTracks: [],
  selectedTrackChannels: new Set(),
  newProfileName: "",
  editingProfileName: null,
  editName: "",
  isDiscoveringTracks: false,
  isApplyingKnob: false,
  builderOpen: false,
  settingsOpen: false,
  startOnLogin: false,
  consoleExpanded: false,
  savedConfigSnapshot: "",
  log: []
};

const app = document.querySelector<HTMLDivElement>("#app");
let meterAnimationFrame = 0;
let renderPaused = false;
let renderQueued = false;
let suppressEditBlur = false;
let localConfigSaveTimer = 0;
let menuResizeFrame = 0;
let menuResizeTimer = 0;
let lastMenuResizeHeight = 0;
let nanoHeartbeatTimer = 0;
let nanoHeartbeatResponseTimer = 0;
let nanoReconnectInFlight = false;
let profileDrag:
  | {
      name: string;
      pointerId: number;
      startY: number;
      list: HTMLElement;
      row: HTMLElement;
      handle: HTMLButtonElement;
      rows: Array<{
        element: HTMLElement;
        name: string;
        index: number;
        top: number;
        height: number;
      }>;
      sourceIndex: number;
      targetIndex: number;
      shiftDistance: number;
    }
  | null = null;
const meterDisplayValues = new Map<string, number>();
const meterPeakValues = new Map<string, number>();
const meterPeakHoldTicks = new Map<string, number>();
const METER_RELEASE_DECAY = 0.6;
const METER_PEAK_HOLD_STEPS = 45;
const METER_PEAK_EPSILON = 0.3;
const METER_LOW_KNEE_DB = -24;
const METER_CLIP_DB = 12;
const METER_LOW_KNEE_LINEAR = dbToLinear(METER_LOW_KNEE_DB);
const METER_CLIP_LINEAR = dbToLinear(METER_CLIP_DB);
const METER_RENDER_WIDTH_SCALE = 0.95;
const METER_REFRESH_OPTIONS = [30, 50, 60];
const NANO_HEARTBEAT_INTERVAL_MS = 60 * 1000;
const NANO_SILENCE_BEFORE_PING_MS = 30 * 60 * 1000;
const NANO_HEARTBEAT_RESPONSE_MS = 7000;
const NANO_HEARTBEAT_MAX_MISSES = 2;

function appendLog(line: string) {
  const timestamp = new Date().toLocaleTimeString();
  state.log = [`${timestamp}  ${line}`, ...state.log].slice(0, 160);
  updateConsoleDom();
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

function resizeMenuWindowToContent() {
  if (!isTauriRuntime()) return;
  const stage = document.querySelector<HTMLElement>(".appStage");
  const panel = document.querySelector<HTMLElement>(".menuPanel");
  if (!stage || !panel) return;

  const stageStyle = window.getComputedStyle(stage);
  const verticalPadding = Number.parseFloat(stageStyle.paddingTop) + Number.parseFloat(stageStyle.paddingBottom);
  const height = Math.ceil(panel.scrollHeight + verticalPadding);
  if (height === lastMenuResizeHeight) return;
  lastMenuResizeHeight = height;

  void invoke("resize_menu_window", { height }).catch((error) => {
    appendLog(`Window resize failed: ${String(error)}`);
  });
}

function scheduleMenuWindowResize() {
  if (!isTauriRuntime()) return;

  if (menuResizeFrame) {
    window.cancelAnimationFrame(menuResizeFrame);
  }

  menuResizeFrame = window.requestAnimationFrame(() => {
    menuResizeFrame = 0;
    resizeMenuWindowToContent();

    window.clearTimeout(menuResizeTimer);
    menuResizeTimer = window.setTimeout(resizeMenuWindowToContent, 260);
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderConsoleLines() {
  return state.log.map((line) => `<p><span>${escapeHtml(line.slice(0, 10))}</span><i></i><em>${escapeHtml(line.slice(10))}</em></p>`).join("");
}

function updateConsoleDom() {
  document.querySelector<HTMLElement>(".consoleToggle em")?.replaceChildren(String(state.log.length));

  if (!state.consoleExpanded) return;
  const consoleBody = document.querySelector<HTMLElement>(".consoleBody");
  if (consoleBody) {
    consoleBody.innerHTML = renderConsoleLines();
  }
}

function dbFromPercent(percent: number) {
  if (percent <= 100) return -60 + (percent / 100) * 60;
  return ((percent - 100) / 20) * 12;
}

function configSnapshot(config: AppConfig | null) {
  if (!config) return "";
  return JSON.stringify({
    profiles: config.profiles
  });
}

function normalizeConfig(config: AppConfig) {
  config.live_meters = config.live_meters ?? true;
  config.meter_refresh_hz = METER_REFRESH_OPTIONS.includes(config.meter_refresh_hz) ? config.meter_refresh_hz : 60;
  return config;
}

function meterRefreshHz() {
  return state.config && METER_REFRESH_OPTIONS.includes(state.config.meter_refresh_hz) ? state.config.meter_refresh_hz : 60;
}

function markConfigClean() {
  state.savedConfigSnapshot = configSnapshot(state.config);
}

function hasUnsavedChanges() {
  return Boolean(state.config) && configSnapshot(state.config) !== state.savedConfigSnapshot;
}

function normalizeMotuIp(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function setMotuIp(value: string) {
  if (!state.config) return "";
  state.config.motu_ip = value;
  scheduleLocalConfigSave();
  return value;
}

function committedMotuIp() {
  if (!state.config) return "";
  const normalized = normalizeMotuIp(state.config.motu_ip);
  if (state.config.motu_ip !== normalized) {
    setMotuIp(normalized);
  }
  return normalized;
}

async function saveLocalConfig() {
  if (!state.config || !isTauriRuntime()) return;

  try {
    await invoke("save_config", { config: state.config });
  } catch (error) {
    appendLog(`Local config save failed: ${String(error)}`);
  }
}

function scheduleLocalConfigSave() {
  if (!state.config || !isTauriRuntime()) return;

  window.clearTimeout(localConfigSaveTimer);
  localConfigSaveTimer = window.setTimeout(() => {
    localConfigSaveTimer = 0;
    void saveLocalConfig();
  }, 250);
}

function percentFromDb(db: number) {
  const clampedDb = Math.max(-60, Math.min(12, db));
  if (clampedDb <= 0) return Math.round(((clampedDb + 60) / 60) * 100);
  return Math.round(100 + (clampedDb / 12) * 20);
}

function dbToLinear(db: number) {
  return Math.pow(10, db / 20);
}

function faderLinearToPercent(value: number) {
  const db = 20 * Math.log10(Math.max(value, 0.0001));
  const clampedDb = Math.max(-60, Math.min(12, db));

  if (clampedDb <= 0) {
    return Math.round(((clampedDb + 60) / 60) * 100);
  }

  return Math.round(100 + (clampedDb / 12) * 20);
}

function percentToFaderLinear(percent: number) {
  const clampedPercent = Math.max(0, Math.min(120, percent));
  const db = clampedPercent <= 100 ? -60 + (clampedPercent / 100) * 60 : ((clampedPercent - 100) / 20) * 12;
  return Math.min(4, Math.pow(10, db / 20));
}

function percentToKnobPosition(percent: number) {
  const clampedPercent = Math.max(0, Math.min(120, percent));
  const db = clampedPercent <= 100 ? -60 + (clampedPercent / 100) * 60 : ((clampedPercent - 100) / 20) * 12;
  return Math.max(0, Math.min(60, Math.round(((db + 60) / 72) * 60)));
}

function profileMeta(profile: Profile) {
  const channels = profile.channel.length ? `ch ${profile.channel.join(", ")}` : "no channels";
  const db = dbFromPercent(profile.level);
  return `${profile.desc} / ${channels} / ${profile.level}% / ${db.toFixed(1)} dB`;
}

function activeProfile() {
  return state.config?.profiles.find((candidate) => candidate.name === state.currentProfile) ?? null;
}

function channelMeter(channel: number) {
  return Math.max(0, Math.min(1, state.motuMeters[channel] ?? 0));
}

function profileMeter(profile: Profile) {
  if (!profile.channel.length) return 0;
  const fader = percentToFaderLinear(profile.level);
  return Math.max(...profile.channel.map((channel) => channelMeter(channel) * fader));
}

function profileChannelMeter(profile: Profile, channel: number) {
  return channelMeter(channel) * percentToFaderLinear(profile.level);
}

function rawMeterPercent(value: number) {
  return (Math.max(0, Math.min(METER_CLIP_LINEAR, value)) * 100).toFixed(3);
}

function meterDisplayWarp(linearValue: number) {
  const value = Math.max(0, linearValue);
  if (value <= 0) return 0;

  if (value <= METER_LOW_KNEE_LINEAR) {
    return 0.25 * Math.max(0, Math.min(1, value / METER_LOW_KNEE_LINEAR));
  }

  const db = 20 * Math.log10(value);
  const normalized = (db - METER_LOW_KNEE_DB) / (METER_CLIP_DB - METER_LOW_KNEE_DB);
  return Math.max(0, Math.min(1, 0.25 + 0.75 * normalized));
}

function renderLevelBar(value: number, label: string) {
  const meterId = label.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const percent = rawMeterPercent(value);
  return `
    <div class="meter" title="${escapeHtml(label)}" data-meter="${escapeHtml(meterId)}" data-meter-value="${percent}">
      <canvas width="240" height="16"></canvas>
    </div>
  `;
}

function canRenderMeterTick() {
  const activeElement = document.activeElement;
  return (
    state.menuVisible &&
    (state.config?.live_meters ?? true) &&
    !profileDrag &&
    !state.editingProfileName &&
    activeElement?.tagName !== "INPUT" &&
    activeElement?.tagName !== "SELECT"
  );
}

function drawMeterCanvas(meter: HTMLElement) {
  const meterId = meter.dataset.meter;
  const target = Number(meter.dataset.meterValue ?? 0);
  const targetValues = meter.dataset.meterValues
    ?.split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value));
  if (!Number.isFinite(target) && !targetValues?.length) return;

  const canvas = meter.firstElementChild as HTMLCanvasElement | null;
  const rect = meter.getBoundingClientRect();
  if (!canvas || rect.width <= 0 || rect.height <= 0) return;

  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * pixelRatio));
  const height = Math.max(1, Math.round(rect.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
  ctx.fillRect(0, 0, width, height);

  const values = targetValues?.length ? targetValues : [target];
  const gap = (values.length === 6 ? 1 : 1.5) * pixelRatio;
  const rowHeight = height / values.length;

  values.forEach((targetValue, index) => {
    const key = meterId ? `${meterId}:${index}` : `meter:${index}`;
    const clampedTarget = Math.max(0, Math.min(METER_CLIP_LINEAR * 100, targetValue));
    const previous = meterDisplayValues.get(key);
    const nextValue = previous === undefined || clampedTarget > previous
      ? clampedTarget
      : Math.max(clampedTarget, previous * METER_RELEASE_DECAY);
    const value = Math.max(0, nextValue);
    meterDisplayValues.set(key, value);

    const previousPeak = meterPeakValues.get(key) ?? 0;
    let peakHoldTicks = meterPeakHoldTicks.get(key) ?? 0;
    if (clampedTarget > previousPeak + METER_PEAK_EPSILON) {
      peakHoldTicks = 0;
    }

    const decayedPeak = peakHoldTicks >= METER_PEAK_HOLD_STEPS
      ? previousPeak * METER_RELEASE_DECAY
      : previousPeak;
    const nextPeak = Math.max(clampedTarget, decayedPeak);
    meterPeakValues.set(key, nextPeak);
    meterPeakHoldTicks.set(key, clampedTarget > previousPeak ? peakHoldTicks : peakHoldTicks + 1);

    const y = Math.round(index * rowHeight + gap / 2);
    const h = Math.max(1, Math.round(rowHeight - gap));
    const fillWidth = meterDisplayWarp(value / 100) * width * METER_RENDER_WIDTH_SCALE;

    if (fillWidth > 0) {
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "#0F71BC");
      gradient.addColorStop(0.5, "#2196f3");
      gradient.addColorStop(0.78, "#7cc4f5");
      gradient.addColorStop(0.88, "#f59e0b");
      gradient.addColorStop(0.96, "#ef4444");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, y, fillWidth, h);

      if (fillWidth > 4) {
        ctx.shadowColor = "#2196f3";
        ctx.shadowBlur = 4 * pixelRatio;
        ctx.fillRect(0, y, fillWidth, h);
        ctx.shadowBlur = 0;
      }
    }

    const peakX = Math.min(width - 1, meterDisplayWarp(nextPeak / 100) * width * METER_RENDER_WIDTH_SCALE);
    if (peakX > 3) {
      ctx.fillStyle = "#a8d8f5";
      ctx.fillRect(peakX, y, Math.max(1, Math.round(pixelRatio)), h);
    }
  });
}

function updateMeterCanvases() {
  document.querySelectorAll<HTMLElement>("[data-meter]").forEach((meter) => {
    drawMeterCanvas(meter);
  });
}

function scheduleMeterDomUpdate(force = false) {
  if (meterAnimationFrame) return;
  meterAnimationFrame = window.requestAnimationFrame(() => {
    meterAnimationFrame = 0;
    if (!force && !canRenderMeterTick()) return;
    updateRenderedMeterTargets();
    updateMeterCanvases();
  });
}

function handleMotuMeters(meters: MotuMeterLevels) {
  if (!state.menuVisible || !(state.config?.live_meters ?? true)) return;

  const wasOnline = state.metersOnline;
  state.motuMeters = Object.fromEntries(
    Object.entries(meters.levels).map(([channel, value]) => [Number(channel), value])
  );
  state.metersOnline = true;
  if (canRenderMeterTick()) {
    scheduleMeterDomUpdate();
  }

  if (!wasOnline) {
    render();
  }
}

function handleMotuMeterStats(stats: MotuMeterStats) {
  state.meterStats = stats;
}

function desiredMeterStream() {
  if (!state.config || !state.menuVisible || !state.config.live_meters) return null;
  const motuIp = normalizeMotuIp(state.motuConnectedIp);
  if (!motuIp) return null;
  const refreshHz = meterRefreshHz();
  return {
    motuIp,
    refreshHz,
    key: `${motuIp}@${refreshHz}`
  };
}

async function stopMotuMeterStream(clearMeters = true) {
  if (!isTauriRuntime()) return;

  try {
    await invoke("stop_motu_meter_stream");
  } catch (error) {
    appendLog(`MOTU meter stop failed: ${String(error)}`);
  }

  state.meterStreamRunning = false;
  state.meterStreamKey = "";
  state.metersOnline = false;
  state.meterStats = null;

  if (clearMeters) {
    state.motuMeters = {};
    scheduleMeterDomUpdate(state.menuVisible);
  }
}

async function syncMotuMeterStream() {
  if (!isTauriRuntime()) return;

  const desired = desiredMeterStream();
  if (!desired) {
    if (state.meterStreamRunning || state.meterStreamKey) {
      await stopMotuMeterStream();
    }
    return;
  }

  if (state.meterStreamRunning && state.meterStreamKey === desired.key) return;

  if (state.meterStreamRunning || state.meterStreamKey) {
    await stopMotuMeterStream(false);
  }

  try {
    await invoke("start_motu_meter_stream", {
      motuIp: desired.motuIp,
      refreshHz: desired.refreshHz
    });
    state.meterStreamRunning = true;
    state.meterStreamKey = desired.key;
  } catch (error) {
    state.meterStreamRunning = false;
    state.meterStreamKey = "";
    state.metersOnline = false;
    appendLog(`MOTU meter stream failed: ${String(error)}`);
  }
}

async function connectMotu() {
  if (!state.config) return;
  const motuIp = committedMotuIp();
  if (!motuIp) {
    appendLog("Enter a MOTU IP address first");
    render();
    return;
  }

  state.metersOnline = false;
  render();

  try {
    await stopMotuMeterStream();
    await saveLocalConfig();
    await refreshAllProfileLevelsFromMotu();
    state.motuConnectedIp = motuIp;
    await syncMotuMeterStream();
    appendLog(`MOTU connected at ${motuIp}`);
    render();
  } catch (error) {
    state.motuConnectedIp = "";
    state.metersOnline = false;
    appendLog(`MOTU connect failed: ${String(error)}`);
    render();
  }
}

async function disconnectMotu() {
  await stopMotuMeterStream();

  state.motuConnectedIp = "";
  state.metersOnline = false;
  state.meterStats = null;
  appendLog("MOTU disconnected");
  render();
}

function updateRenderedMeterTargets() {
  document.querySelectorAll<HTMLElement>("[data-profile-meter]").forEach((meter) => {
    const profileName = meter.dataset.profileMeter;
    const profile = state.config?.profiles.find((candidate) => candidate.name === profileName);
    if (!profile) return;
    meter.dataset.meterValue = rawMeterPercent(profileMeter(profile));
    meter.dataset.meterValues = profile.channel
      .map((channel) => rawMeterPercent(profileChannelMeter(profile, channel)))
      .join(",");
  });

  document.querySelectorAll<HTMLElement>("[data-channel-meter]").forEach((meter) => {
    const channel = Number(meter.dataset.channelMeter);
    const profileName = meter.dataset.channelProfile;
    const profile = state.config?.profiles.find((candidate) => candidate.name === profileName);
    if (!Number.isFinite(channel)) return;
    meter.dataset.meterValue = rawMeterPercent(profile ? profileChannelMeter(profile, channel) : channelMeter(channel));
  });
}

async function loadConfig() {
  state.config = normalizeConfig(await invoke<AppConfig>("load_config"));
  markConfigClean();
  appendLog(`Loaded ${state.config.profiles.length} profiles`);
}

async function loadStartOnLoginSetting() {
  if (!isTauriRuntime()) return;

  try {
    state.startOnLogin = await invoke<boolean>("get_start_on_login");
  } catch (error) {
    appendLog(`Start on login check failed: ${String(error)}`);
  }
}

async function setStartOnLogin(enabled: boolean) {
  const previous = state.startOnLogin;
  state.startOnLogin = enabled;
  render();

  try {
    state.startOnLogin = await invoke<boolean>("set_start_on_login", { enabled });
    appendLog(`Start on login ${state.startOnLogin ? "enabled" : "disabled"}`);
  } catch (error) {
    state.startOnLogin = previous;
    appendLog(`Start on login update failed: ${String(error)}`);
  }

  render();
}

function quitApp() {
  if (!isTauriRuntime()) return;
  void invoke("quit_app");
}

function setLiveMeters(enabled: boolean) {
  if (!state.config) return;
  state.config.live_meters = enabled;
  void saveLocalConfig();
  void syncMotuMeterStream().then(render);
}

function setMeterRefreshHz(value: number) {
  if (!state.config) return;
  const refreshHz = METER_REFRESH_OPTIONS.includes(value) ? value : 60;
  state.config.meter_refresh_hz = refreshHz;
  void saveLocalConfig();
  void syncMotuMeterStream().then(render);
}

async function refreshPorts() {
  state.ports = await invoke<SerialPortInfo[]>("list_serial_ports");
  const nano = state.ports.find((port) => {
    const haystack = `${port.path} ${port.name ?? ""}`.toLowerCase();
    return haystack.includes("nano") || haystack.includes("usbmodem");
  });
  state.selectedPort = state.selectedPort || nano?.path || state.ports[0]?.path || "";
  render();
}

async function requestDeviceProfileState(options: { quiet?: boolean } = {}) {
  if (state.connection !== "connected") return;
  await invoke("send_nano_json", { payload: { profiles: "#all" } });
  if (!options.quiet) appendLog('Sent Nano {"profiles":"#all"}');
}

function markNanoSeen() {
  state.lastNanoSeenAt = Date.now();
  state.nanoHeartbeatMisses = 0;
}

function stopNanoHeartbeat() {
  if (nanoHeartbeatTimer) {
    window.clearInterval(nanoHeartbeatTimer);
    nanoHeartbeatTimer = 0;
  }
  if (nanoHeartbeatResponseTimer) {
    window.clearTimeout(nanoHeartbeatResponseTimer);
    nanoHeartbeatResponseTimer = 0;
  }
}

async function reconnectNano(reason: string) {
  if (nanoReconnectInFlight || !state.selectedPort) return;
  nanoReconnectInFlight = true;
  stopNanoHeartbeat();
  appendLog(`Nano reconnecting: ${reason}`);
  state.connection = "connecting";
  render();

  try {
    await invoke("disconnect_nano");
  } catch {
    // The port may already be gone; reconnect will do the useful check.
  }

  try {
    await refreshPorts();
    await invoke("connect_nano", { path: state.selectedPort });
    state.connection = "connected";
    markNanoSeen();
    appendLog(`Nano reconnected to ${state.selectedPort}`);
    await requestDeviceProfileState();
    startNanoHeartbeat();
  } catch (error) {
    state.connection = "disconnected";
    state.currentProfile = "";
    state.lastKnobPosition = null;
    state.expectedDeviceKnobPosition = null;
    state.nanoHeartbeatMisses = 0;
    appendLog(`Nano reconnect failed: ${String(error)}`);
  } finally {
    nanoReconnectInFlight = false;
    render();
  }
}

function recordNanoHeartbeatMiss(reason: string) {
  if (state.connection !== "connected") return;
  state.nanoHeartbeatMisses += 1;
  appendLog(`Nano heartbeat missed (${state.nanoHeartbeatMisses}/${NANO_HEARTBEAT_MAX_MISSES}): ${reason}`);

  if (state.nanoHeartbeatMisses >= NANO_HEARTBEAT_MAX_MISSES) {
    void reconnectNano("heartbeat timed out");
  }
}

async function pingNano() {
  if (state.connection !== "connected" || nanoReconnectInFlight) return;
  if (Date.now() - state.lastNanoSeenAt < NANO_SILENCE_BEFORE_PING_MS) return;

  const sentAt = Date.now();
  appendLog("Nano silent for 30 minutes; checking connection");

  try {
    await requestDeviceProfileState({ quiet: true });
  } catch (error) {
    recordNanoHeartbeatMiss(`write failed: ${String(error)}`);
    return;
  }

  if (nanoHeartbeatResponseTimer) {
    window.clearTimeout(nanoHeartbeatResponseTimer);
  }
  nanoHeartbeatResponseTimer = window.setTimeout(() => {
    if (state.connection === "connected" && state.lastNanoSeenAt < sentAt) {
      recordNanoHeartbeatMiss("no response");
    }
  }, NANO_HEARTBEAT_RESPONSE_MS);
}

function startNanoHeartbeat() {
  stopNanoHeartbeat();
  if (state.connection !== "connected") return;
  nanoHeartbeatTimer = window.setInterval(() => {
    void pingNano();
  }, NANO_HEARTBEAT_INTERVAL_MS);
}

async function connectSelectedPort() {
  if (!state.selectedPort) {
    appendLog("No serial port selected");
    return;
  }

  state.connection = "connecting";
  render();

  try {
    await invoke("connect_nano", { path: state.selectedPort });
    state.connection = "connected";
    markNanoSeen();
    appendLog(`Connected to ${state.selectedPort}`);
    await requestDeviceProfileState();
    startNanoHeartbeat();
  } catch (error) {
    state.connection = "disconnected";
    stopNanoHeartbeat();
    appendLog(`Connect failed: ${String(error)}`);
  }

  render();
}

async function disconnect() {
  stopNanoHeartbeat();
  await invoke("disconnect_nano");
  state.connection = "disconnected";
  state.currentProfile = "";
  state.lastKnobPosition = null;
  state.expectedDeviceKnobPosition = null;
  state.lastNanoSeenAt = 0;
  state.nanoHeartbeatMisses = 0;
  state.ignoreKnobUntil = 0;
  appendLog("Disconnected");
  render();
}

async function syncProfiles() {
  if (!state.config) return;
  const preferredProfile = state.config.profiles.some((profile) => profile.name === state.currentProfile)
    ? state.currentProfile
    : (state.config.profiles[0]?.name ?? "");

  try {
    await invoke("sync_profiles", { config: state.config });
    await saveLocalConfig();
    markConfigClean();
    appendLog("Profile sync commands sent");
    if (preferredProfile) {
      await invoke("send_nano_json", { payload: { current: preferredProfile } });
      state.currentProfile = preferredProfile;
      state.lastKnobPosition = null;
      await syncActiveProfileLevelToDevice("profile sync");
    }
  } catch (error) {
    appendLog(`Profile sync failed: ${String(error)}`);
  }
}

function revertConfigChanges() {
  if (!state.savedConfigSnapshot) return;

  state.config = JSON.parse(state.savedConfigSnapshot) as AppConfig;
  state.editingProfileName = null;
  state.editName = "";
  state.selectedTrackChannels.clear();
  state.newProfileName = "";
  appendLog("Reverted local profile changes");
  void saveLocalConfig();
  render();
}

async function discoverMotuTracks() {
  if (!state.config || state.isDiscoveringTracks) return;
  const motuIp = committedMotuIp();
  if (!motuIp) {
    appendLog("Enter a MOTU IP address before scanning");
    render();
    return;
  }

  state.isDiscoveringTracks = true;
  appendLog("Scanning MOTU channels...");
  render();

  try {
    state.motuTracks = await invoke<MotuTrack[]>("discover_motu_tracks", {
      motuIp,
      startChannel: 0,
      endChannel: 47
    });
    appendLog(`Found ${state.motuTracks.length} MOTU channels`);
  } catch (error) {
    appendLog(`MOTU scan failed: ${String(error)}`);
  } finally {
    state.isDiscoveringTracks = false;
    render();
  }
}

function toggleTrackSelection(channel: number) {
  if (state.selectedTrackChannels.has(channel)) {
    state.selectedTrackChannels.delete(channel);
  } else {
    state.selectedTrackChannels.add(channel);
  }

  if (!state.newProfileName) {
    const selected = selectedTracks();
    if (selected.length === 1) {
      state.newProfileName = selected[0].name;
    } else if (selected.length > 1) {
      state.newProfileName = "New Multitrack";
    }
  }

  render();
}

function selectedTracks() {
  return state.motuTracks.filter((track) => state.selectedTrackChannels.has(track.channel));
}

function profileTrackCountLabel(trackCount: number) {
  return trackCount === 1 ? "1 track" : `${trackCount} tracks`;
}

function trackAudioChannelCount(track: MotuTrack) {
  return Math.max(1, track.channel_count ?? 1);
}

function trackChannelLabel(track: MotuTrack) {
  const count = trackAudioChannelCount(track);
  if (count <= 1) return `ch ${track.channel}`;
  return `ch ${track.channel}-${track.channel + count - 1}`;
}

function trackAudioChannels(track: MotuTrack) {
  return Array.from({ length: trackAudioChannelCount(track) }, (_, index) => track.channel + index);
}

function parseChannels(value: string) {
  const channels = value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);

  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    return null;
  }

  return Array.from(new Set(channels));
}

async function createProfileFromSelection() {
  if (!state.config) return;

  const tracks = selectedTracks();
  if (tracks.length === 0) {
    appendLog("Select one or more MOTU tracks first");
    return;
  }

  const rawName = state.newProfileName.trim() || tracks.map((track) => track.name).join(" + ");
  const name = uniqueProfileName(rawName);
  const level = tracks.length === 1 ? tracks[0].percent : Math.round(tracks.reduce((sum, track) => sum + track.percent, 0) / tracks.length);
  const channels = Array.from(new Set(tracks.flatMap(trackAudioChannels)));

  const profile: Profile = {
    name,
    desc: profileTrackCountLabel(channels.length),
    channel: channels,
    level
  };

  state.config.profiles.push(profile);
  state.selectedTrackChannels.clear();
  state.newProfileName = "";
  state.builderOpen = false;
  appendLog(`Created profile '${profile.name}' for channels ${profile.channel.join(", ")}`);
  void saveLocalConfig();
  render();
}

function uniqueProfileName(baseName: string) {
  if (!state.config) return baseName;

  const existing = new Set(state.config.profiles.map((profile) => profile.name));
  if (!existing.has(baseName)) return baseName;

  let index = 2;
  while (existing.has(`${baseName} ${index}`)) {
    index += 1;
  }

  return `${baseName} ${index}`;
}

function startEditProfile(profile: Profile) {
  state.editingProfileName = profile.name;
  state.editName = profile.name;
  render();
}

function cancelEditProfile() {
  state.editingProfileName = null;
  state.editName = "";
  render();
}

function saveEditProfileName(originalName: string) {
  if (!state.config) return;

  const profile = state.config.profiles.find((candidate) => candidate.name === originalName);
  if (!profile) return;

  const name = state.editName.trim();

  if (!name) {
    appendLog("Profile name cannot be blank");
    return;
  }

  const nameTaken = state.config.profiles.some((candidate) => candidate.name === name && candidate.name !== originalName);
  if (nameTaken) {
    appendLog(`Profile '${name}' already exists`);
    return;
  }

  profile.name = name;

  if (state.currentProfile === originalName) {
    state.currentProfile = name;
  }

  appendLog(`Renamed profile '${originalName}' to '${name}' locally. Save sends it to Nano.`);
  void saveLocalConfig();
  cancelEditProfile();
}

function deleteProfile(name: string) {
  if (!state.config) return;

  state.config.profiles = state.config.profiles.filter((profile) => profile.name !== name);
  if (state.currentProfile === name) {
    state.currentProfile = state.config.profiles[0]?.name ?? "";
  }
  if (state.editingProfileName === name) {
    state.editingProfileName = null;
    state.editName = "";
  }
  appendLog(`Deleted profile '${name}' locally. Save sends it to Nano.`);
  void saveLocalConfig();
  render();
}

function moveProfile(name: string, direction: -1 | 1) {
  if (!state.config) return;

  const index = state.config.profiles.findIndex((profile) => profile.name === name);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= state.config.profiles.length) return;

  const [profile] = state.config.profiles.splice(index, 1);
  state.config.profiles.splice(target, 0, profile);
  appendLog(`Moved '${name}' ${direction < 0 ? "up" : "down"} locally. Save sends order to Nano.`);
  void saveLocalConfig();
  render();
}

function profileDragTargetIndex(clientY: number) {
  const drag = profileDrag;
  if (!drag) return;

  const deltaY = clientY - drag.startY;
  const rowOffset = Math.round(deltaY / drag.shiftDistance);
  return Math.max(0, Math.min(drag.rows.length - 1, drag.sourceIndex + rowOffset));
}

function updateProfileDragTransforms(clientY: number) {
  const drag = profileDrag;
  if (!drag) return;

  const deltaY = clientY - drag.startY;
  const targetIndex = profileDragTargetIndex(clientY) ?? drag.sourceIndex;
  drag.targetIndex = targetIndex;

  drag.rows.forEach((row) => {
    let translateY = 0;
    if (row.index === drag.sourceIndex) {
      translateY = deltaY;
    } else if (drag.sourceIndex < targetIndex && row.index > drag.sourceIndex && row.index <= targetIndex) {
      translateY = -drag.shiftDistance;
    } else if (drag.sourceIndex > targetIndex && row.index >= targetIndex && row.index < drag.sourceIndex) {
      translateY = drag.shiftDistance;
    }

    row.element.style.transform = translateY ? `translate3d(0, ${translateY}px, 0)` : "";
  });
}

function clearProfileDragTransforms() {
  if (!profileDrag) return;
  profileDrag.rows.forEach((row) => {
    row.element.style.transform = "";
    row.element.classList.remove("dragShifted", "dragSource");
  });
}

function profileRowsForDrag(list: HTMLElement) {
  return Array.from(list.querySelectorAll<HTMLElement>("[data-profile-row]")).map((element, index) => {
    const rect = element.getBoundingClientRect();
    return {
      element,
      name: element.dataset.profileRow ?? "",
      index,
      top: rect.top,
      height: rect.height
    };
  });
}

function profileDragShiftDistance(rows: Array<{ top: number; height: number }>, sourceIndex: number) {
  const source = rows[sourceIndex];
  const next = rows[sourceIndex + 1];
  const previous = rows[sourceIndex - 1];

  if (next) {
    return Math.max(source.height, next.top - source.top);
  }
  if (previous) {
    return Math.max(source.height, source.top - previous.top);
  }

  return source.height;
}

function applyProfileDragOrder() {
  if (!state.config || !profileDrag) return false;

  const { sourceIndex, targetIndex } = profileDrag;
  if (sourceIndex === targetIndex) return false;

  const [profile] = state.config.profiles.splice(sourceIndex, 1);
  state.config.profiles.splice(targetIndex, 0, profile);

  const timestamp = new Date().toLocaleTimeString();
  state.log = [`${timestamp}  Moved '${profileDrag.name}' locally. Save sends order to Nano.`, ...state.log].slice(0, 160);
  void saveLocalConfig();
  return true;
}

function removeProfileDragWindowListeners() {
  window.removeEventListener("pointermove", handleProfileDragPointerMove);
  window.removeEventListener("pointerup", handleProfileDragPointerUp);
  window.removeEventListener("pointercancel", handleProfileDragPointerCancel);
}

function cleanupProfileDrag(renderAfterCleanup: boolean) {
  if (!profileDrag) return;

  removeProfileDragWindowListeners();
  clearProfileDragTransforms();
  document.body.classList.remove("draggingProfile");
  profileDrag = null;

  if (renderAfterCleanup) {
    render();
  }
}

function handleProfileDragPointerMove(event: PointerEvent) {
  if (!profileDrag || profileDrag.pointerId !== event.pointerId) return;
  event.preventDefault();
  updateProfileDragTransforms(event.clientY);
}

function handleProfileDragPointerUp(event: PointerEvent) {
  if (!profileDrag || profileDrag.pointerId !== event.pointerId) return;
  event.preventDefault();
  updateProfileDragTransforms(event.clientY);
  const handle = profileDrag.handle;
  const changed = applyProfileDragOrder();
  if (handle.hasPointerCapture(event.pointerId)) {
    handle.releasePointerCapture(event.pointerId);
  }
  cleanupProfileDrag(changed);
}

function handleProfileDragPointerCancel(event: PointerEvent) {
  if (!profileDrag || profileDrag.pointerId !== event.pointerId) return;
  const handle = profileDrag.handle;
  if (handle.hasPointerCapture(event.pointerId)) {
    handle.releasePointerCapture(event.pointerId);
  }
  cleanupProfileDrag(true);
}

async function selectProfile(name: string) {
  await invoke("send_nano_json", { payload: { current: name } });
  state.currentProfile = name;
  state.lastKnobPosition = null;
  appendLog(`Selected ${name}`);
  await syncActiveProfileLevelToDevice("profile selected in app");
}

async function applyKnobPosition(position: number) {
  if (!state.config || state.lastKnobPosition === position || state.isApplyingKnob) return;

  if (Date.now() < state.ignoreKnobUntil) {
    appendLog(`Ignored Nano position ${position} during profile handoff`);
    return;
  }

  state.lastKnobPosition = position;

  if (state.expectedDeviceKnobPosition === position) {
    state.expectedDeviceKnobPosition = null;
    appendLog(`Nano level confirmed at position ${position}`);
    return;
  }

  const profile = activeProfile();
  if (!profile) {
    appendLog(`Knob ${position}: no active profile mapping`);
    return;
  }

  state.isApplyingKnob = true;
  let updatedProfile: Profile | null = null;
  try {
    const motuIp = committedMotuIp();
    if (!motuIp) throw new Error("Enter a MOTU IP address first");
    const gain = await invoke<number>("set_channels_from_knob", {
      motuIp,
      channels: profile.channel,
      knobPosition: position
    });

    profile.level = await invoke<number>("knob_position_to_percent", { position });
    updatedProfile = profile;
    void saveLocalConfig();
    appendLog(`Knob ${position} -> ${profile.name} gain ${gain.toFixed(3)}`);
  } catch (error) {
    appendLog(`MOTU update failed: ${String(error)}`);
  } finally {
    state.isApplyingKnob = false;
    if (updatedProfile) {
      updateProfileLevelDom(updatedProfile);
    }
  }
}

async function readProfileLevelFromMotu(profile: Profile, quiet = false) {
  if (!state.config || profile.channel.length === 0) return;
  const motuIp = committedMotuIp();
  if (!motuIp) return;

  const firstChannel = profile.channel[0];
  const value = await invoke<number | null>("get_channel_fader", {
    motuIp,
    channel: firstChannel
  });

  if (typeof value !== "number") {
    if (!quiet) appendLog(`${profile.name}: no MOTU level from ch ${firstChannel}`);
    return;
  }

  profile.level = faderLinearToPercent(value);
  if (!quiet) appendLog(`${profile.name}: MOTU ch ${firstChannel} ${value.toFixed(3)} -> ${profile.level}%`);
}

async function refreshAllProfileLevelsFromMotu() {
  if (!state.config) return;

  appendLog("Reading MOTU levels...");
  for (const profile of state.config.profiles) {
    try {
      await readProfileLevelFromMotu(profile);
    } catch (error) {
      appendLog(`${profile.name}: MOTU read failed: ${String(error)}`);
    }
  }

  state.motuLevelsLoaded = true;
  void saveLocalConfig();
  render();
}

async function syncActiveProfileLevelToDevice(reason: string, options: { refreshFromMotu?: boolean } = {}) {
  if (!state.config || state.connection !== "connected" || !state.currentProfile) return;

  const profile = activeProfile();
  if (!profile) {
    appendLog(`No local profile mapping for '${state.currentProfile}'`);
    return;
  }

  if (options.refreshFromMotu) {
    try {
      await readProfileLevelFromMotu(profile, true);
    } catch (error) {
      appendLog(`${profile.name}: using cached level after MOTU read failed: ${String(error)}`);
    }
  }

  const knobPosition = percentToKnobPosition(profile.level);
  state.expectedDeviceKnobPosition = knobPosition;
  state.lastKnobPosition = null;
  state.ignoreKnobUntil = Date.now() + 700;

  await invoke("send_nano_json", { payload: { level: knobPosition } });
  appendLog(`Sent ${profile.name} level to Nano (${reason}): ${profile.level}% -> position ${knobPosition}`);
  render();
}

async function testMotu(profile: Profile) {
  try {
    await readProfileLevelFromMotu(profile);
    render();
  } catch (error) {
    appendLog(`${profile.name}: MOTU read failed: ${String(error)}`);
  }
}

function faderDbFromPointer(track: HTMLElement, clientX: number) {
  const rect = track.getBoundingClientRect();
  const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
  return -60 + (x / rect.width) * 72;
}

function updateProfileFaderDom(track: HTMLElement, profile: Profile) {
  const row = track.closest<HTMLElement>(".profileRow");
  const thumbLeft = faderThumbPosition(profile);
  const dbLabel = profileDbLabel(profile);

  row?.querySelector<HTMLElement>(".faderThumb")?.style.setProperty("left", thumbLeft);
  const tooltip = row?.querySelector<HTMLElement>(".dbTooltip");
  if (tooltip) {
    tooltip.style.left = thumbLeft;
    tooltip.textContent = `${dbLabel} dB`;
  }

  const readout = row?.querySelector<HTMLElement>(".profileDbReadout div span");
  if (readout) {
    readout.textContent = dbLabel;
  }

  updateRenderedMeterTargets();
  scheduleMeterDomUpdate();
}

function updateProfileLevelDom(profile: Profile) {
  const track = Array.from(document.querySelectorAll<HTMLElement>("[data-fader-profile]"))
    .find((candidate) => candidate.dataset.faderProfile === profile.name);

  if (track) {
    updateProfileFaderDom(track, profile);
  }
}

function previewProfileFader(profileName: string, track: HTMLElement, clientX: number) {
  const profile = state.config?.profiles.find((candidate) => candidate.name === profileName);
  if (!profile) return null;

  profile.level = percentFromDb(faderDbFromPointer(track, clientX));
  updateProfileFaderDom(track, profile);
  return profile;
}

function resetProfileFaderToUnity(profileName: string, track: HTMLElement) {
  const profile = state.config?.profiles.find((candidate) => candidate.name === profileName);
  if (!profile) return;

  profile.level = 100;
  updateProfileFaderDom(track, profile);
  void commitProfileFader(profileName);
}

async function commitProfileFader(profileName: string) {
  if (!state.config) return;

  const profile = state.config.profiles.find((candidate) => candidate.name === profileName);
  if (!profile) return;

  const knobPosition = percentToKnobPosition(profile.level);
  try {
    const motuIp = committedMotuIp();
    if (!motuIp) throw new Error("Enter a MOTU IP address first");
    await invoke("set_channels_from_knob", {
      motuIp,
      channels: profile.channel,
      knobPosition
    });

    if (state.connection === "connected" && state.currentProfile === profile.name) {
      state.expectedDeviceKnobPosition = knobPosition;
      state.lastKnobPosition = null;
      await invoke("send_nano_json", { payload: { level: knobPosition } });
    }

    appendLog(`Set ${profile.name} to ${profileDbLabel(profile)} dB`);
    void saveLocalConfig();
  } catch (error) {
    appendLog(`${profile.name}: fader update failed: ${String(error)}`);
  }
}

function profileTypeLabel(profile: Profile) {
  return profileTrackCountLabel(profile.channel.length);
}

function profileDbLabel(profile: Profile) {
  const db = dbFromPercent(profile.level);
  return `${db > 0 ? "+" : ""}${db.toFixed(1)}`;
}

function faderThumbLeft(profile: Profile) {
  const db = Math.max(-60, Math.min(12, dbFromPercent(profile.level)));
  return ((db + 60) / 72) * 100;
}

function faderThumbPosition(profile: Profile) {
  const percent = faderThumbLeft(profile);
  const edgeOffset = -(12 * percent) / 100;
  return `calc(${percent.toFixed(2)}% + ${edgeOffset.toFixed(2)}px)`;
}

function profileMeterHeight(profile: Profile) {
  return profile.channel.length >= 4 ? 22 : 18;
}

function shortPortLabel() {
  if (!state.selectedPort) return "USB";
  const segment = state.selectedPort.split("/").filter(Boolean).at(-1) ?? state.selectedPort;
  const match = segment.match(/(\d+)$/);
  return match ? `USB·${match[1]}` : "USB";
}

function settingsIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"></path>
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 1 1-4 0V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8a2 2 0 1 1 0-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 .9-1.6V2.8a2 2 0 1 1 4 0V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6.9h.2a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z"></path>
    </svg>
  `;
}

function plusIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14"></path>
      <path d="M5 12h14"></path>
    </svg>
  `;
}

function gripIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="5" r="1"></circle>
      <circle cx="9" cy="12" r="1"></circle>
      <circle cx="9" cy="19" r="1"></circle>
      <circle cx="15" cy="5" r="1"></circle>
      <circle cx="15" cy="12" r="1"></circle>
      <circle cx="15" cy="19" r="1"></circle>
    </svg>
  `;
}

function trashIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18"></path>
      <path d="M8 6V4h8v2"></path>
      <path d="M19 6l-1 14H6L5 6"></path>
      <path d="M10 11v5"></path>
      <path d="M14 11v5"></path>
    </svg>
  `;
}

function chevronIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 9 6 6 6-6"></path>
    </svg>
  `;
}

function renderProfileMeter(profile: Profile) {
  const meterId = `${profile.name}-meter`.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const values = profile.channel.map((channel) => rawMeterPercent(profileChannelMeter(profile, channel))).join(",");
  return `
    <div class="audioMeter" data-meter="${escapeHtml(meterId)}" data-profile-meter="${escapeHtml(profile.name)}" data-meter-value="${rawMeterPercent(profileMeter(profile))}" data-meter-values="${values}">
      <canvas width="360" height="${profileMeterHeight(profile)}"></canvas>
    </div>
  `;
}

function portLabel(port: SerialPortInfo) {
  return port.name && port.name !== port.path ? `${port.name} / ${port.path}` : port.path;
}

function statusText() {
  if (state.connection === "connected") return "Connected";
  if (state.connection === "connecting") return "Connecting";
  return "Disconnected";
}

function renderProfileRow(profile: Profile, index: number, profiles: Profile[], selected: boolean) {
  const isEditing = state.editingProfileName === profile.name;
  const rowClass = `profileRow${selected ? " selected" : ""}${isEditing ? " editing" : ""}`;
  const thumbLeft = faderThumbPosition(profile);
  const dbLabel = profileDbLabel(profile);
  const meterHeight = profileMeterHeight(profile);

  if (isEditing) {
    return `
      <article class="${rowClass}" data-profile-row="${escapeHtml(profile.name)}">
        <div class="profileStrip">
          <div class="profileNameGroup">
            <span class="dragGrip visible">${gripIcon()}</span>
            <input class="profileNameInput" id="editName" data-edit-original="${escapeHtml(profile.name)}" placeholder="Profile name" value="${escapeHtml(state.editName)}" autofocus />
          </div>
          <div class="profileRightGroup">
            <div class="profileDbReadout">
              <span>${escapeHtml(profileTypeLabel(profile))}</span>
              <div><span>${dbLabel}</span><em>dB</em></div>
            </div>
            <button class="deleteProfileButton" data-delete="${escapeHtml(profile.name)}" title="Delete profile">${trashIcon()}</button>
          </div>
        </div>
        <div class="profileMeterPad">
          <div class="faderSurface" style="height: ${meterHeight}px">
            <div class="meterLayer">
              ${renderProfileMeter(profile)}
            </div>
            <div class="zeroLine"></div>
            <div class="faderTrack" data-fader-profile="${escapeHtml(profile.name)}">
              <div class="faderThumb" style="left: ${thumbLeft}">
                <i></i><i></i><i></i>
              </div>
              <div class="dbTooltip" style="left: ${thumbLeft}">${dbLabel} dB</div>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  return `
    <article class="${rowClass}" data-profile-row="${escapeHtml(profile.name)}">
      <div class="profileStrip">
        <div class="profileNameGroup">
          <button class="dragGrip" data-drag-profile="${escapeHtml(profile.name)}" title="Drag to reorder">${gripIcon()}</button>
          <button class="profileNameText" data-start-edit="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</button>
        </div>
        <div class="profileRightGroup">
          <div class="profileDbReadout">
            <span>${escapeHtml(profileTypeLabel(profile))}</span>
            <div><span>${dbLabel}</span><em>dB</em></div>
          </div>
        </div>
      </div>
      <div class="profileMeterPad">
        <div class="faderSurface" style="height: ${meterHeight}px">
          <div class="meterLayer">
            ${renderProfileMeter(profile)}
          </div>
          <div class="zeroLine"></div>
          <div class="faderTrack" data-fader-profile="${escapeHtml(profile.name)}">
            <div class="faderThumb" style="left: ${thumbLeft}">
              <i></i><i></i><i></i>
            </div>
            <div class="dbTooltip" style="left: ${thumbLeft}">${dbLabel} dB</div>
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderBuilder() {
  if (!state.builderOpen || state.settingsOpen) return "";

  const selected = selectedTracks();
  return `
    <section class="builder">
      <div class="sectionHeader">
        <div>
          <span class="labelTracked">Tracks</span>
          <strong>${state.motuTracks.length}</strong>
        </div>
        <button data-scan-tracks>${state.isDiscoveringTracks ? "Scanning" : "Scan"}</button>
      </div>
      <div class="builderControls">
        <input id="newProfileName" placeholder="Profile name" value="${escapeHtml(state.newProfileName)}" />
        <button id="createProfile" ${selected.length ? "" : "disabled"}>${selected.length > 1 ? "Create Multitrack" : "Create"}</button>
      </div>
      ${state.motuTracks.length
        ? `
          <div class="trackGrid">
            ${state.motuTracks
              .map(
                (track) => `
                  <button class="track ${state.selectedTrackChannels.has(track.channel) ? "selected" : ""}" data-track="${track.channel}">
                    <span>${escapeHtml(track.name)}</span>
                  </button>
                `
              )
              .join("")}
          </div>
        `
        : ""}
    </section>
  `;
}

function renderSettingsPanel() {
  return `
    <div class="settingsPanel">
      <label class="settingsRow" for="startOnLogin">
        <strong>Start on Login</strong>
        <span class="switchToggle">
          <input id="startOnLogin" type="checkbox" ${state.startOnLogin ? "checked" : ""} />
          <span></span>
        </span>
      </label>
      <label class="settingsRow" for="liveMeters">
        <strong>Live Meters</strong>
        <span class="switchToggle">
          <input id="liveMeters" type="checkbox" ${(state.config?.live_meters ?? true) ? "checked" : ""} />
          <span></span>
        </span>
      </label>
      <label class="settingsRow" for="meterRefreshHz">
        <strong>Meter Rate</strong>
        <select id="meterRefreshHz" class="settingsSelect">
          ${METER_REFRESH_OPTIONS.map((rate) => `<option value="${rate}" ${rate === meterRefreshHz() ? "selected" : ""}>${rate} Hz</option>`).join("")}
        </select>
      </label>
      <button id="quitApp" class="quitButton">Quit</button>
    </div>
  `;
}

function render() {
  if (!app) return;
  if (renderPaused) {
    renderQueued = true;
    return;
  }

  const config = state.config;
  const active = state.connection === "connected";
  const motuActive = Boolean(state.motuConnectedIp);
  const dirty = hasUnsavedChanges();

  app.innerHTML = `
    <main class="appStage">
      <section class="menuPanel">
        <header class="panelHeader">
          <div class="brandBlock">
            <img src="/MOTU.svg" alt="MOTU" />
            <span></span>
            <strong>Controller</strong>
          </div>
          <button id="toggleSettings" class="settingsButton ${state.settingsOpen ? "active" : ""}" title="Settings">${settingsIcon()}</button>
        </header>

        <section class="connectionBlock">
          <div class="deviceLine">
            <div class="deviceIdentity">
              <span class="pulseDot ${motuActive || state.metersOnline ? "online" : ""}"></span>
              <div>
                <strong>828es</strong>
                <small>Audio Interface</small>
              </div>
            </div>
            ${motuActive
              ? `
                <div class="nanoStatus">
                  <button id="disconnectMotu" class="connectedText" title="Disconnect MOTU">Connected</button>
                  <span>${escapeHtml(state.motuConnectedIp)}</span>
                </div>
              `
              : `
                <div class="motuControls">
                  <input id="motuIp" class="ipInput" value="${escapeHtml(config?.motu_ip ?? "")}" placeholder="MOTU IP" ${config ? "" : "disabled"} />
                  <button id="connectMotu" ${config ? "" : "disabled"}>Connect</button>
                </div>
              `}
          </div>
          <div class="deviceLine">
            <div class="deviceIdentity">
              <span class="pulseDot ${active ? "online" : ""}"></span>
              <div>
                <strong>Nano-D++</strong>
                <small>MIDI Controller</small>
              </div>
            </div>
            ${active
              ? `
                <div class="nanoStatus">
                  <button id="connect" class="connectedText" title="Disconnect">${statusText()}</button>
                  <span>${escapeHtml(shortPortLabel())}</span>
                </div>
              `
              : `
                <div class="nanoControls">
                  <select id="portSelect" class="portSelect">
                    ${state.ports
                      .map((port) => `<option value="${escapeHtml(port.path)}" ${port.path === state.selectedPort ? "selected" : ""}>${escapeHtml(portLabel(port))}</option>`)
                      .join("")}
                  </select>
                  <button id="connect">${statusText() === "Connecting" ? "Connecting" : "Connect"}</button>
                </div>
              `}
          </div>
        </section>

        <div class="divider"></div>

        <section class="profileSection ${state.settingsOpen ? "settingsMode" : ""}">
          <div class="profileListHeader">
            <div>
              <span class="labelTracked">${state.settingsOpen ? "Settings" : "Profiles"}</span>
              <span class="countText">${state.settingsOpen ? "App" : (config?.profiles.length ?? 0)}</span>
            </div>
            ${state.settingsOpen
              ? ""
              : `
                <button id="toggleBuilder" class="addProfileButton" title="${state.builderOpen ? "Close" : "Add Profile"}">
                  ${state.builderOpen ? "" : plusIcon()}
                  <span>${state.builderOpen ? "Close" : state.isDiscoveringTracks ? "Scanning" : "Add"}</span>
                </button>
              `}
          </div>
          ${state.settingsOpen
            ? renderSettingsPanel()
            : state.builderOpen
              ? ""
              : `
                <div class="profileList">
                  ${(config?.profiles ?? []).map((profile, index, profiles) => renderProfileRow(profile, index, profiles, profile.name === state.currentProfile)).join("")}
                </div>
              `}
        </section>

        ${renderBuilder()}

        ${dirty
          ? `
            <section class="actionBar">
              <button id="revertProfiles">Revert</button>
              <button id="syncProfiles" class="primaryAction" ${active ? "" : "disabled"}>Save</button>
            </section>
          `
          : ""}

        <section class="console ${state.consoleExpanded ? "expanded" : ""}">
          <button id="toggleLog" class="consoleToggle">
            <div>
              <span class="chevron">${chevronIcon()}</span>
              <strong>Console</strong>
              <em>${state.log.length}</em>
            </div>
            <span class="liveState">Live</span>
          </button>
          <div class="consoleBody">
            ${renderConsoleLines()}
          </div>
        </section>
      </section>
    </main>
  `;

  document.querySelector<HTMLInputElement>("#motuIp")?.addEventListener("input", (event) => {
    if (!state.config) return;
    setMotuIp((event.currentTarget as HTMLInputElement).value);
  });
  document.querySelector<HTMLInputElement>("#motuIp")?.addEventListener("blur", () => {
    if (!state.config) return;
    committedMotuIp();
    render();
  });
  document.querySelector("#connectMotu")?.addEventListener("click", connectMotu);
  document.querySelector("#disconnectMotu")?.addEventListener("click", disconnectMotu);
  document.querySelector<HTMLSelectElement>("#portSelect")?.addEventListener("change", (event) => {
    state.selectedPort = (event.currentTarget as HTMLSelectElement).value;
  });
  document.querySelector("#toggleSettings")?.addEventListener("click", () => {
    state.settingsOpen = !state.settingsOpen;
    if (state.settingsOpen) {
      state.builderOpen = false;
    }
    render();
  });
  document.querySelector("#connect")?.addEventListener("click", () => (active ? disconnect() : connectSelectedPort()));
  document.querySelector("#revertProfiles")?.addEventListener("click", revertConfigChanges);
  document.querySelector("#toggleBuilder")?.addEventListener("click", () => {
    state.settingsOpen = false;
    state.builderOpen = !state.builderOpen;
    render();
    if (state.builderOpen && !state.motuTracks.length) {
      void discoverMotuTracks();
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-scan-tracks]").forEach((button) => {
    button.addEventListener("click", discoverMotuTracks);
  });
  document.querySelector("#requestState")?.addEventListener("click", () => requestDeviceProfileState());
  document.querySelector("#syncProfiles")?.addEventListener("click", syncProfiles);
  document.querySelector("#toggleLog")?.addEventListener("click", () => {
    state.consoleExpanded = !state.consoleExpanded;
    render();
  });
  document.querySelector<HTMLInputElement>("#startOnLogin")?.addEventListener("change", (event) => {
    void setStartOnLogin((event.currentTarget as HTMLInputElement).checked);
  });
  document.querySelector<HTMLInputElement>("#liveMeters")?.addEventListener("change", (event) => {
    setLiveMeters((event.currentTarget as HTMLInputElement).checked);
  });
  document.querySelector<HTMLSelectElement>("#meterRefreshHz")?.addEventListener("change", (event) => {
    setMeterRefreshHz(Number((event.currentTarget as HTMLSelectElement).value));
  });
  document.querySelector("#quitApp")?.addEventListener("click", quitApp);
  document.querySelector<HTMLInputElement>("#newProfileName")?.addEventListener("input", (event) => {
    state.newProfileName = (event.currentTarget as HTMLInputElement).value;
  });
  document.querySelector("#createProfile")?.addEventListener("click", createProfileFromSelection);
  document.querySelector<HTMLInputElement>("#editName")?.addEventListener("input", (event) => {
    state.editName = (event.currentTarget as HTMLInputElement).value;
  });
  document.querySelector<HTMLInputElement>("#editName")?.addEventListener("keydown", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const originalName = input.dataset.editOriginal ?? "";
    if (event.key === "Enter") {
      event.preventDefault();
      saveEditProfileName(originalName);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEditProfile();
    }
  });
  document.querySelector<HTMLInputElement>("#editName")?.addEventListener("blur", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    window.setTimeout(() => {
      if (suppressEditBlur) return;
      if (state.editingProfileName === input.dataset.editOriginal) {
        saveEditProfileName(input.dataset.editOriginal ?? "");
      }
    }, 0);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((button) => {
    const profile = state.config?.profiles.find((candidate) => candidate.name === button.dataset.edit);
    if (profile) button.addEventListener("click", () => startEditProfile(profile));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-start-edit]").forEach((button) => {
    const profile = state.config?.profiles.find((candidate) => candidate.name === button.dataset.startEdit);
    if (profile) button.addEventListener("click", () => startEditProfile(profile));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      suppressEditBlur = true;
    });
    button.addEventListener("pointerup", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const name = button.dataset.delete ?? "";
      if (name) {
        deleteProfile(name);
      }
      window.setTimeout(() => {
        suppressEditBlur = false;
      }, 0);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-drag-profile]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      const row = button.closest<HTMLElement>("[data-profile-row]");
      const list = row?.parentElement;
      const name = button.dataset.dragProfile ?? "";
      if (!row || !list || !name) return;

      event.preventDefault();
      event.stopPropagation();
      button.setPointerCapture(event.pointerId);

      const rows = profileRowsForDrag(list);
      const sourceIndex = rows.findIndex((candidate) => candidate.element === row);
      if (sourceIndex < 0) return;

      row.classList.add("dragSource");
      rows.forEach((candidate) => candidate.element.classList.add("dragShifted"));
      profileDrag = {
        name,
        pointerId: event.pointerId,
        startY: event.clientY,
        list,
        row,
        handle: button,
        rows,
        sourceIndex,
        targetIndex: sourceIndex,
        shiftDistance: profileDragShiftDistance(rows, sourceIndex)
      };
      updateProfileDragTransforms(event.clientY);
      window.addEventListener("pointermove", handleProfileDragPointerMove, { passive: false });
      window.addEventListener("pointerup", handleProfileDragPointerUp, { passive: false });
      window.addEventListener("pointercancel", handleProfileDragPointerCancel, { passive: false });
      document.body.classList.add("draggingProfile");
    });
    button.addEventListener("pointermove", (event) => {
      handleProfileDragPointerMove(event);
    });
    button.addEventListener("pointerup", (event) => {
      handleProfileDragPointerUp(event);
    });
    button.addEventListener("pointercancel", (event) => {
      handleProfileDragPointerCancel(event);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-track]").forEach((button) => {
    button.addEventListener("click", () => toggleTrackSelection(Number(button.dataset.track)));
  });
  document.querySelectorAll<HTMLElement>("[data-fader-profile]").forEach((track) => {
    let dragging = false;
    const profileName = track.dataset.faderProfile ?? "";

    track.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      dragging = false;
      resetProfileFaderToUnity(profileName, track);
    });

    track.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      dragging = true;
      track.setPointerCapture(event.pointerId);
      previewProfileFader(profileName, track, event.clientX);
    });

    track.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      previewProfileFader(profileName, track, event.clientX);
    });

    const endDrag = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (track.hasPointerCapture(event.pointerId)) {
        track.releasePointerCapture(event.pointerId);
      }
      previewProfileFader(profileName, track, event.clientX);
      void commitProfileFader(profileName);
    };

    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-select]").forEach((button) => {
    button.addEventListener("click", () => selectProfile(button.dataset.select ?? ""));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-test]").forEach((button) => {
    const profile = state.config?.profiles.find((candidate) => candidate.name === button.dataset.test);
    if (profile) button.addEventListener("click", () => testMotu(profile));
  });

  scheduleMeterDomUpdate(state.menuVisible);
  scheduleMenuWindowResize();
}

async function withPausedRender(task: () => Promise<void>) {
  renderPaused = true;
  renderQueued = false;
  try {
    await task();
  } finally {
    renderPaused = false;
    if (renderQueued) {
      renderQueued = false;
      render();
    }
  }
}

async function boot() {
  if (!isTauriRuntime()) {
    bootBrowserPreview();
    return;
  }

  await listen<MotuMeterLevels>("motu://meters", (event) => {
    handleMotuMeters(event.payload);
  });

  await listen<MotuMeterStats>("motu://meter-stats", (event) => {
    handleMotuMeterStats(event.payload);
  });

  await listen<string>("motu://meter-error", (event) => {
    if (state.metersOnline) {
      state.metersOnline = false;
      state.motuConnectedIp = "";
      state.meterStreamRunning = false;
      state.meterStreamKey = "";
      appendLog(`MOTU meter stream paused: ${event.payload}`);
      render();
    }
  });

  await listen<boolean>("app://menu-visible", (event) => {
    state.menuVisible = event.payload;
    void syncMotuMeterStream().then(() => {
      if (!state.menuVisible) {
        render();
      }
    });
  });

  await listen<string>("nano://disconnected", (event) => {
    if (state.connection === "connected") {
      void reconnectNano(`serial reader stopped: ${event.payload}`);
    }
  });

  await listen<NanoEvent>("nano://line", (event) => {
    markNanoSeen();
    const json = event.payload.json;
    if (json?.idle) return;

    if (Array.isArray(json?.profiles)) {
      appendLog(`Nano profiles: ${json.profiles.join(", ")}`);
    }

    if (typeof json?.current === "string") {
      const changed = state.currentProfile !== json.current;
      state.currentProfile = json.current;
      state.lastKnobPosition = null;
      state.expectedDeviceKnobPosition = null;
      if (changed) {
        void syncActiveProfileLevelToDevice("Nano profile changed");
      }
    }

    if (typeof json?.p === "number") {
      void applyKnobPosition(json.p);
    }

    appendLog(`Nano ${event.payload.line}`);
  });

  await withPausedRender(async () => {
    await loadConfig();
    await loadStartOnLoginSetting();
    await refreshAllProfileLevelsFromMotu();
    markConfigClean();
    await refreshPorts();
    if (state.config?.motu_ip) {
      state.motuConnectedIp = normalizeMotuIp(state.config.motu_ip);
    }
  });

  if (state.selectedPort) {
    await connectSelectedPort();
  }

  render();
}

void boot();

function bootBrowserPreview() {
  state.config = {
    motu_ip: "192.168.1.42",
    live_meters: true,
    meter_refresh_hz: 60,
    profiles: [
      { name: "Main Out", desc: "Stereo", channel: [0, 1], level: 90 },
      { name: "Surround 5.1", desc: "5.1", channel: [0, 1, 2, 3, 4, 5], level: 80 },
      { name: "Headphones", desc: "Stereo", channel: [6, 7], level: 70 },
      { name: "Studio B", desc: "Stereo", channel: [8, 9], level: 47 }
    ]
  };
  state.ports = [{ path: "/dev/cu.usbmodem2", name: "Nano-D++", serial_number: null, vendor_id: null, product_id: null }];
  state.selectedPort = "/dev/cu.usbmodem2";
  state.connection = "connected";
  state.menuVisible = true;
  state.metersOnline = true;
  state.meterStats = { packets: 120, errors: 0, packets_per_second: 58.8, last_latency_ms: 12, last_error: null };
  state.motuMeters = {
    0: 0.42,
    1: 0.34,
    2: 0.37,
    3: 0.29,
    4: 0.31,
    5: 0.24,
    6: 0.88,
    7: 0.76,
    8: 0.44,
    9: 0.31
  };
  state.log = [
    "12:07:01  Buffer underrun recovered",
    "12:06:42  High latency on ch.3 (12.4ms)",
    "12:05:15  Syncing fader positions (3 channels)",
    "12:05:02  Profile \"Main Out\" loaded",
    "12:04:19  AVB stream established - 48kHz / 24bit",
    "12:04:19  Nano-D++ handshake complete - USB 2",
    "12:04:18  Connected to MOTU 828es at 192.168.1.42"
  ];
  render();
}
