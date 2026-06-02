use std::{
    collections::HashMap,
    env,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, ErrorKind, Write},
    path::PathBuf,
    process,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::{stream, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use serialport::{SerialPort, SerialPortInfo, SerialPortType};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    ActivationPolicy, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, Rect, State,
    WebviewWindow, Window, WindowEvent,
};
use thiserror::Error;

const BAUD_RATE: u32 = 115_200;
const CONFIG_DIR_NAME: &str = "MOTU Controller";
const CONFIG_FILE_NAME: &str = "config.json";
const LOGIN_AGENT_LABEL: &str = "com.champ.motu-controller";
const LEGACY_LOGIN_AGENT_LABEL: &str = "com.champ.motu-controller-codex";
const POSITION_LOG_PATH: &str = "/tmp/motu-controller-window.log";
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray.png");

#[derive(Debug, Error)]
enum AppError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Serial(#[from] serialport::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

type AppResult<T> = Result<T, AppError>;
type SharedSerial = Arc<Mutex<Box<dyn SerialPort>>>;

#[derive(Default)]
struct AppState {
    serial: Mutex<Option<SharedSerial>>,
    reader_stop: Mutex<Option<Arc<AtomicBool>>>,
    meter_stop: Mutex<Option<Arc<AtomicBool>>>,
    last_tray_rect: Mutex<Option<Rect>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Profile {
    name: String,
    desc: String,
    channel: Vec<u16>,
    level: i16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppConfig {
    motu_ip: String,
    #[serde(default = "default_live_meters")]
    live_meters: bool,
    #[serde(default = "default_meter_refresh_hz")]
    meter_refresh_hz: u16,
    profiles: Vec<Profile>,
}

#[derive(Debug, Serialize)]
struct UiSerialPortInfo {
    path: String,
    name: Option<String>,
    serial_number: Option<String>,
    vendor_id: Option<String>,
    product_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct NanoLineEvent {
    line: String,
    json: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
struct MotuTrack {
    channel: u16,
    name: String,
    fader: f32,
    percent: i16,
    format: String,
    channel_count: u16,
    kind: String,
}

#[derive(Debug, Clone)]
struct MotuChannelScan {
    channel: u16,
    name: Option<String>,
    fader: Option<f32>,
    format: String,
    channel_count: u16,
}

#[derive(Debug, Clone, Serialize)]
struct MotuMeterLevels {
    levels: HashMap<u16, f32>,
    frame_count: usize,
}

#[derive(Debug, Clone, Serialize)]
struct MotuMeterStats {
    packets: u64,
    errors: u64,
    packets_per_second: f32,
    last_latency_ms: u64,
    last_error: Option<String>,
}

fn mix_level_frame_order(body: &str) -> Vec<String> {
    let mut frames = Vec::new();
    let needle = "\"mix/level/";
    let mut rest = body;

    while let Some(index) = rest.find(needle) {
        let after_prefix = &rest[index + needle.len()..];
        let digits_len = after_prefix
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .map(char::len_utf8)
            .sum::<usize>();

        if digits_len > 0 {
            frames.push(format!("mix/level/{}", &after_prefix[..digits_len]));
        }

        rest = &after_prefix[digits_len..];
    }

    frames
}

fn port_name(info: &SerialPortInfo) -> Option<String> {
    match &info.port_type {
        SerialPortType::UsbPort(usb) => usb.product.clone().or_else(|| usb.manufacturer.clone()),
        SerialPortType::BluetoothPort => Some("Bluetooth".to_string()),
        SerialPortType::PciPort => Some("PCI".to_string()),
        SerialPortType::Unknown => None,
    }
}

fn profile_update(profile: &Profile) -> Value {
    json!({
        "version": 2,
        "name": profile.name,
        "desc": profile.desc,
        "profileTag": "",
        "isFader": true,
        "ledEnable": true,
        "ledBrightness": 100,
        "ledMode": 0,
        "pointer": 10839618,
        "primary": 2490368,
        "secondary": 0,
        "buttonAIdle": 16711680,
        "buttonBIdle": 16711680,
        "buttonCIdle": 16711680,
        "buttonDIdle": 16711680,
        "buttonAPress": 16750397,
        "buttonBPress": 16749629,
        "buttonCPress": 16749629,
        "buttonDPress": 16749629,
        "keys": [
            { "pressed": [{ "type": "prev_profile" }] },
            { "pressed": [] },
            { "pressed": [] },
            { "pressed": [{ "type": "next_profile" }] }
        ],
        "knob": [
            {
                "valueMin": 0,
                "valueMax": 100,
                "angleMin": 0,
                "angleMax": 0,
                "wrap": false,
                "step": 0,
                "keyState": 0,
                "haptic": {
                    "mode": 0,
                    "startPos": 0,
                    "endPos": 60,
                    "detentCount": 60,
                    "vernier": 0,
                    "kxForce": false,
                    "outputRamp": 10000,
                    "detentStrength": 0
                },
                "type": "midi",
                "channel": 1,
                "cc": 30
            }
        ],
        "guiEnable": false,
        "audio": {
            "clickType": "hard",
            "keyClickType": "clack",
            "clickLevel": 100
        }
    })
}

fn write_json(port: &SharedSerial, payload: &Value) -> AppResult<()> {
    let mut line = serde_json::to_string(payload)?;
    line.push('\n');

    let mut port = port
        .lock()
        .map_err(|_| AppError::Message("Serial lock poisoned".to_string()))?;
    port.write_all(line.as_bytes())?;
    port.flush()?;
    Ok(())
}

fn knob_position_to_gain(position: i16) -> f32 {
    let percent = (position.clamp(0, 60) as f32 / 60.0) * 100.0;
    let db = (percent / 100.0) * 72.0 - 60.0;
    10_f32.powf(db / 20.0).min(4.0)
}

fn fader_linear_to_percent(value: f32) -> i16 {
    let db = 20.0 * value.max(0.0001).log10();
    let clamped_db = db.clamp(-60.0, 12.0);

    if clamped_db <= 0.0 {
        (((clamped_db + 60.0) / 60.0) * 100.0).round() as i16
    } else {
        (100.0 + (clamped_db / 12.0) * 20.0).round() as i16
    }
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn reset_position_log() {
    let _ = fs::write(
        POSITION_LOG_PATH,
        format!(
            "{} pid={} reset window positioning log\n",
            timestamp_ms(),
            process::id()
        ),
    );
}

fn log_position(message: impl AsRef<str>) {
    let line = format!(
        "{} pid={} {}\n",
        timestamp_ms(),
        process::id(),
        message.as_ref()
    );

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(POSITION_LOG_PATH)
    {
        let _ = file.write_all(line.as_bytes());
    }

    eprint!("{line}");
}

fn log_window_snapshot(label: &str, window: &WebviewWindow) {
    log_position(format!(
        "{label}: visible={:?} focused={:?} outer_pos={:?} inner_pos={:?} outer_size={:?} inner_size={:?} scale={:?}",
        window.is_visible(),
        window.is_focused(),
        window.outer_position(),
        window.inner_position(),
        window.outer_size(),
        window.inner_size(),
        window.scale_factor()
    ));
}

fn log_native_window_snapshot(label: &str, window: &Window) {
    log_position(format!(
        "{label}: visible={:?} focused={:?} outer_pos={:?} inner_pos={:?} outer_size={:?} inner_size={:?} scale={:?}",
        window.is_visible(),
        window.is_focused(),
        window.outer_position(),
        window.inner_position(),
        window.outer_size(),
        window.inner_size(),
        window.scale_factor()
    ));
}

fn log_monitors(app: &tauri::AppHandle, label: &str) {
    match app.available_monitors() {
        Ok(monitors) => {
            log_position(format!(
                "{label}: available_monitors count={}",
                monitors.len()
            ));
            for (index, monitor) in monitors.iter().enumerate() {
                log_position(format!(
                    "{label}: monitor[{index}] name={:?} pos={:?} size={:?} work_area={:?} scale={}",
                    monitor.name(),
                    monitor.position(),
                    monitor.size(),
                    monitor.work_area(),
                    monitor.scale_factor()
                ));
            }
        }
        Err(error) => log_position(format!("{label}: available_monitors error={error}")),
    }
}

fn monitor_containing_physical_point(app: &tauri::AppHandle, x: i32, y: i32) -> Option<Monitor> {
    match app.available_monitors() {
        Ok(monitors) => {
            for monitor in monitors {
                let position = monitor.position();
                let size = monitor.size();
                let min_x = position.x;
                let max_x = position.x + size.width as i32;
                let min_y = position.y;
                let max_y = position.y + size.height as i32;

                if x >= min_x && x < max_x && y >= min_y && y < max_y {
                    log_position(format!(
                        "monitor_containing_physical_point: manual match point=({x},{y}) monitor name={:?} pos={position:?} size={size:?} work_area={:?} scale={}",
                        monitor.name(),
                        monitor.work_area(),
                        monitor.scale_factor()
                    ));
                    return Some(monitor);
                }
            }

            log_position(format!(
                "monitor_containing_physical_point: no manual match for point=({x},{y})"
            ));
        }
        Err(error) => log_position(format!(
            "monitor_containing_physical_point: available_monitors error={error}"
        )),
    }

    let fallback = app.monitor_from_point(x as f64, y as f64).ok().flatten();
    log_position(format!(
        "monitor_containing_physical_point: monitor_from_point fallback for point=({x},{y}) -> {:?}",
        fallback.as_ref().map(|monitor| (
            monitor.name().cloned(),
            *monitor.position(),
            *monitor.size(),
            *monitor.work_area(),
            monitor.scale_factor()
        ))
    ));
    fallback
}

fn default_config() -> AppConfig {
    AppConfig {
        motu_ip: String::new(),
        live_meters: default_live_meters(),
        meter_refresh_hz: default_meter_refresh_hz(),
        profiles: Vec::new(),
    }
}

fn default_live_meters() -> bool {
    true
}

fn default_meter_refresh_hz() -> u16 {
    60
}

fn user_config_path() -> AppResult<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
        AppError::Message("Could not resolve home directory for local config".to_string())
    })?;

    Ok(home
        .join("Library")
        .join("Application Support")
        .join(CONFIG_DIR_NAME)
        .join(CONFIG_FILE_NAME))
}

fn write_user_config(config: &AppConfig) -> AppResult<()> {
    let path = user_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let json = serde_json::to_string_pretty(config)?;
    fs::write(path, format!("{json}\n"))?;
    Ok(())
}

#[tauri::command]
fn load_config() -> AppResult<AppConfig> {
    let path = user_config_path()?;
    if path.exists() {
        let config = fs::read_to_string(path)?;
        return Ok(serde_json::from_str(&config)?);
    }

    let config = default_config();
    write_user_config(&config)?;
    Ok(config)
}

#[tauri::command]
fn save_config(config: AppConfig) -> AppResult<()> {
    write_user_config(&config)
}

fn login_agent_path_for(label: &str) -> AppResult<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
        AppError::Message("Could not resolve home directory for login item".to_string())
    })?;

    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{label}.plist")))
}

fn login_agent_path() -> AppResult<PathBuf> {
    login_agent_path_for(LOGIN_AGENT_LABEL)
}

fn current_app_bundle_path() -> AppResult<PathBuf> {
    let executable = env::current_exe()?;
    let mut path = executable.as_path();

    while let Some(parent) = path.parent() {
        if parent.extension().and_then(|extension| extension.to_str()) == Some("app") {
            return Ok(parent.to_path_buf());
        }
        path = parent;
    }

    Ok(executable)
}

fn escape_plist_string(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn login_agent_plist() -> AppResult<String> {
    let app_path = current_app_bundle_path()?;
    let app_path = escape_plist_string(&app_path.to_string_lossy());

    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LOGIN_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>{app_path}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
    ))
}

fn remove_legacy_login_agent() -> AppResult<()> {
    let legacy_path = login_agent_path_for(LEGACY_LOGIN_AGENT_LABEL)?;
    if let Err(error) = fs::remove_file(legacy_path) {
        if error.kind() != ErrorKind::NotFound {
            return Err(error.into());
        }
    }

    Ok(())
}

#[tauri::command]
fn get_start_on_login() -> AppResult<bool> {
    remove_legacy_login_agent()?;
    let path = login_agent_path()?;
    if path.exists() {
        fs::write(&path, login_agent_plist()?)?;
        return Ok(true);
    }

    Ok(false)
}

#[tauri::command]
fn set_start_on_login(enabled: bool) -> AppResult<bool> {
    remove_legacy_login_agent()?;
    let path = login_agent_path()?;

    if enabled {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, login_agent_plist()?)?;
    } else if let Err(error) = fs::remove_file(path) {
        if error.kind() != ErrorKind::NotFound {
            return Err(error.into());
        }
    }

    Ok(enabled)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    log_position("command: quit_app");
    app.exit(0);
}

#[tauri::command]
fn list_serial_ports() -> AppResult<Vec<UiSerialPortInfo>> {
    let mut ports: Vec<_> = serialport::available_ports()?
        .into_iter()
        .map(|info| {
            let (serial_number, vendor_id, product_id) = match &info.port_type {
                SerialPortType::UsbPort(usb) => (
                    usb.serial_number.clone(),
                    Some(format!("{:04X}", usb.vid)),
                    Some(format!("{:04X}", usb.pid)),
                ),
                _ => (None, None, None),
            };

            UiSerialPortInfo {
                name: port_name(&info),
                path: info.port_name,
                serial_number,
                vendor_id,
                product_id,
            }
        })
        .collect();

    ports.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ports)
}

#[tauri::command]
fn connect_nano(path: String, app: tauri::AppHandle, state: State<AppState>) -> AppResult<()> {
    {
        let mut serial = state
            .serial
            .lock()
            .map_err(|_| AppError::Message("Serial state lock poisoned".to_string()))?;
        *serial = None;
    }
    {
        let mut reader_stop = state
            .reader_stop
            .lock()
            .map_err(|_| AppError::Message("Reader state lock poisoned".to_string()))?;
        if let Some(stop) = reader_stop.take() {
            stop.store(true, Ordering::SeqCst);
        }
    }

    let port = serialport::new(&path, BAUD_RATE)
        .timeout(Duration::from_millis(100))
        .open()?;
    let reader_port = port.try_clone()?;
    let shared = Arc::new(Mutex::new(port));
    let stop_reader = Arc::new(AtomicBool::new(false));

    {
        let mut serial = state
            .serial
            .lock()
            .map_err(|_| AppError::Message("Serial state lock poisoned".to_string()))?;
        *serial = Some(shared);
    }
    {
        let mut reader_stop = state
            .reader_stop
            .lock()
            .map_err(|_| AppError::Message("Reader state lock poisoned".to_string()))?;
        *reader_stop = Some(stop_reader.clone());
    }

    thread::spawn(move || {
        let mut reader = BufReader::new(reader_port);
        while !stop_reader.load(Ordering::SeqCst) {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    thread::sleep(Duration::from_millis(20));
                }
                Ok(bytes_read) => {
                    if bytes_read == 0 {
                        continue;
                    }

                    let trimmed = line.trim().to_string();
                    if trimmed.is_empty() {
                        continue;
                    }

                    let parsed = serde_json::from_str::<Value>(&trimmed).ok();
                    let _ = app.emit(
                        "nano://line",
                        NanoLineEvent {
                            line: trimmed,
                            json: parsed,
                        },
                    );
                }
                Err(error) if error.kind() == ErrorKind::TimedOut => {
                    continue;
                }
                Err(error) => {
                    let _ = app.emit("nano://disconnected", error.to_string());
                    break;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn disconnect_nano(state: State<AppState>) -> AppResult<()> {
    {
        let mut reader_stop = state
            .reader_stop
            .lock()
            .map_err(|_| AppError::Message("Reader state lock poisoned".to_string()))?;
        if let Some(stop) = reader_stop.take() {
            stop.store(true, Ordering::SeqCst);
        }
    }

    let mut serial = state
        .serial
        .lock()
        .map_err(|_| AppError::Message("Serial state lock poisoned".to_string()))?;
    *serial = None;
    Ok(())
}

#[tauri::command]
fn send_nano_json(payload: Value, state: State<AppState>) -> AppResult<()> {
    let port = {
        let serial = state
            .serial
            .lock()
            .map_err(|_| AppError::Message("Serial state lock poisoned".to_string()))?;
        serial
            .as_ref()
            .cloned()
            .ok_or_else(|| AppError::Message("Nano-D++ is not connected".to_string()))?
    };

    write_json(&port, &payload)
}

#[tauri::command]
fn sync_profiles(config: AppConfig, state: State<AppState>) -> AppResult<()> {
    if config.profiles.is_empty() {
        return Err(AppError::Message(
            "At least one profile is required before syncing".to_string(),
        ));
    }

    let port = {
        let serial = state
            .serial
            .lock()
            .map_err(|_| AppError::Message("Serial state lock poisoned".to_string()))?;
        serial
            .as_ref()
            .cloned()
            .ok_or_else(|| AppError::Message("Nano-D++ is not connected".to_string()))?
    };

    write_json(&port, &json!({ "profiles": [] }))?;
    thread::sleep(Duration::from_millis(200));

    for profile in &config.profiles {
        write_json(
            &port,
            &json!({
                "profile": profile.name,
                "updates": profile_update(profile)
            }),
        )?;
        thread::sleep(Duration::from_millis(120));
    }

    let keep_list: Vec<_> = config
        .profiles
        .iter()
        .map(|profile| profile.name.clone())
        .collect();
    write_json(&port, &json!({ "profiles": keep_list }))?;
    write_json(&port, &json!({ "settings": { "idleTimeout": 300000 } }))?;
    write_json(&port, &json!({ "save": true }))?;

    Ok(())
}

#[tauri::command]
async fn get_channel_fader(motu_ip: String, channel: u16) -> AppResult<Option<f32>> {
    let url = format!("{motu_ip}/datastore/mix/chan/{channel}/matrix/fader");
    let json: Value = Client::builder()
        .timeout(Duration::from_millis(1200))
        .build()?
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(json
        .get("value")
        .and_then(Value::as_f64)
        .map(|value| value as f32))
}

async fn get_obank_channel_name(client: &Client, motu_ip: &str, channel: u16) -> Option<String> {
    let url = format!("{motu_ip}/datastore/ext/obank/12/ch/{channel}/name");
    let response = tokio::time::timeout(Duration::from_millis(700), client.get(url).send())
        .await
        .ok()?
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let json = response.json::<Value>().await.ok()?;
    let value = json.get("value").and_then(Value::as_str)?.trim();

    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

async fn get_mix_channel_format(client: &Client, motu_ip: &str, channel: u16) -> Option<String> {
    let url = format!("{motu_ip}/datastore/mix/chan/{channel}/config/format");
    let response = tokio::time::timeout(Duration::from_millis(700), client.get(url).send())
        .await
        .ok()?
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let json = response.json::<Value>().await.ok()?;
    json.get("value")
        .and_then(Value::as_str)
        .map(str::to_string)
}

async fn get_mix_channel_fader(client: &Client, motu_ip: &str, channel: u16) -> Option<f32> {
    let url = format!("{motu_ip}/datastore/mix/chan/{channel}/matrix/fader");
    let response = tokio::time::timeout(Duration::from_millis(700), client.get(url).send())
        .await
        .ok()?
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let json = tokio::time::timeout(Duration::from_millis(250), response.json::<Value>())
        .await
        .ok()?
        .ok()?;

    json.get("value")
        .and_then(Value::as_f64)
        .map(|value| value as f32)
}

fn format_channel_count(format: &str) -> u16 {
    format
        .split(':')
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1)
}

fn format_kind(format: &str) -> String {
    match format_channel_count(format) {
        1 => "Mono".to_string(),
        2 => "Stereo".to_string(),
        6 => "5.1".to_string(),
        count => format!("{count} ch"),
    }
}

fn common_channel_name(names: &[String]) -> Option<String> {
    let first = names.first()?.trim();
    if names.len() == 1 {
        return Some(first.to_string());
    }

    let mut prefix = first.to_string();
    for name in names.iter().skip(1) {
        while !name.starts_with(&prefix) {
            if prefix.pop().is_none() {
                break;
            }
        }

        if prefix.is_empty() {
            break;
        }
    }

    let trimmed = prefix
        .trim()
        .trim_end_matches(|character: char| matches!(character, '-' | '_' | '/' | '\\' | '(' | '['))
        .trim();

    if trimmed.len() >= 2 {
        Some(trimmed.to_string())
    } else {
        Some(first.to_string())
    }
}

#[tauri::command]
async fn discover_motu_tracks(
    motu_ip: String,
    start_channel: u16,
    end_channel: u16,
) -> AppResult<Vec<MotuTrack>> {
    let client = Client::builder()
        .timeout(Duration::from_millis(900))
        .build()?;
    let end_channel = end_channel
        .max(start_channel)
        .min(start_channel.saturating_add(127));
    let mut channels: Vec<_> = stream::iter(start_channel..=end_channel)
        .map(|channel| {
            let client = client.clone();
            let motu_ip = motu_ip.clone();

            async move {
                let name = get_obank_channel_name(&client, &motu_ip, channel).await;
                let format = get_mix_channel_format(&client, &motu_ip, channel)
                    .await
                    .unwrap_or_else(|| "1:0".to_string());
                let fader = get_mix_channel_fader(&client, &motu_ip, channel).await;
                let channel_count = format_channel_count(&format);

                MotuChannelScan {
                    channel,
                    name,
                    fader,
                    format,
                    channel_count,
                }
            }
        })
        .buffer_unordered(6)
        .collect()
        .await;
    channels.sort_by_key(|channel| channel.channel);

    let mut tracks = Vec::new();
    let mut index = 0;
    while let Some(scan) = channels.get(index) {
        let channel_count = scan.channel_count.max(1);
        let group_end = scan.channel.saturating_add(channel_count.saturating_sub(1));
        let mut group_index = index;
        let mut group_names = Vec::new();
        let mut fader = scan.fader;

        while let Some(group_channel) = channels.get(group_index) {
            if group_channel.channel > group_end {
                break;
            }

            if let Some(name) = &group_channel.name {
                group_names.push(name.clone());
            }

            if fader.is_none() {
                fader = group_channel.fader;
            }

            group_index += 1;
        }

        if let (Some(name), Some(fader)) = (common_channel_name(&group_names), fader) {
            tracks.push(MotuTrack {
                channel: scan.channel,
                name,
                fader,
                percent: fader_linear_to_percent(fader),
                format: scan.format.clone(),
                channel_count,
                kind: format_kind(&scan.format),
            });
        }

        index = group_index.max(index + 1);
    }

    Ok(tracks)
}

#[tauri::command]
async fn get_motu_mix_levels(motu_ip: String) -> AppResult<MotuMeterLevels> {
    let url = format!("{motu_ip}/meters?meters=mix/level");
    let body = Client::builder()
        .timeout(Duration::from_millis(700))
        .build()?
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let frame_order = mix_level_frame_order(&body);
    let json: Value = serde_json::from_str(&body)?;

    Ok(parse_motu_mix_levels(&json, &frame_order))
}

fn parse_motu_mix_levels(json: &Value, frame_order: &[String]) -> MotuMeterLevels {
    let mut levels: HashMap<u16, f32> = HashMap::new();
    let Some(object) = json.as_object() else {
        return MotuMeterLevels {
            levels,
            frame_count: 1,
        };
    };

    let mut ordered_frames = frame_order.to_vec();
    if ordered_frames.is_empty() {
        ordered_frames = object
            .keys()
            .filter(|path| path.starts_with("mix/level/"))
            .cloned()
            .collect();
        ordered_frames.sort();
    }

    for path in &ordered_frames {
        let Some(values) = object.get(path).and_then(Value::as_array) else {
            continue;
        };

        for (channel, value) in values.iter().enumerate() {
            let Some(raw) = value.as_f64() else {
                continue;
            };
            let normalized = ((raw as f32) / 1000.0).clamp(0.0, 1.0);
            levels.insert(channel as u16, normalized);
        }
    }

    MotuMeterLevels {
        levels,
        frame_count: ordered_frames.len().max(1),
    }
}

#[tauri::command]
async fn start_motu_meter_stream(
    motu_ip: String,
    refresh_hz: u16,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    {
        let mut meter_stop = state
            .meter_stop
            .lock()
            .map_err(|_| AppError::Message("Meter state lock poisoned".to_string()))?;
        if let Some(stop) = meter_stop.take() {
            stop.store(true, Ordering::SeqCst);
        }

        let stop = Arc::new(AtomicBool::new(false));
        *meter_stop = Some(stop.clone());
        let frame_interval = Duration::from_millis(1000 / u64::from(refresh_hz.clamp(1, 60)));

        tauri::async_runtime::spawn(async move {
            let client = match Client::builder().timeout(Duration::from_secs(15)).build() {
                Ok(client) => client,
                Err(error) => {
                    let _ = app.emit("motu://meter-error", error.to_string());
                    return;
                }
            };
            let url = format!(
                "{motu_ip}/meters?meters=mix/gate:mix/comp:mix/level:mix/leveler:ext/input"
            );
            let mut packets = 0_u64;
            let mut errors = 0_u64;
            let mut packets_since_report = 0_u64;
            let mut last_report = Instant::now();
            let mut last_latency_ms = 0_u64;
            let mut last_error: Option<String> = None;

            while !stop.load(Ordering::SeqCst) {
                let started = Instant::now();
                let mut error_this_packet = false;
                match client.get(&url).send().await {
                    Ok(response) => match response.error_for_status() {
                        Ok(response) => match response.text().await {
                            Ok(body) => {
                                packets += 1;
                                packets_since_report += 1;
                                last_latency_ms = started.elapsed().as_millis() as u64;
                                let frame_order = mix_level_frame_order(&body);
                                match serde_json::from_str::<Value>(&body) {
                                    Ok(json) => {
                                        let _ = app.emit(
                                            "motu://meters",
                                            parse_motu_mix_levels(&json, &frame_order),
                                        );
                                    }
                                    Err(error) => {
                                        errors += 1;
                                        error_this_packet = true;
                                        last_error = Some(error.to_string());
                                        let _ = app.emit(
                                            "motu://meter-error",
                                            last_error.clone().unwrap_or_default(),
                                        );
                                    }
                                }
                            }
                            Err(error) => {
                                errors += 1;
                                error_this_packet = true;
                                last_error = Some(error.to_string());
                                let _ = app.emit(
                                    "motu://meter-error",
                                    last_error.clone().unwrap_or_default(),
                                );
                            }
                        },
                        Err(error) => {
                            errors += 1;
                            error_this_packet = true;
                            last_error = Some(error.to_string());
                            let _ = app
                                .emit("motu://meter-error", last_error.clone().unwrap_or_default());
                            tokio::time::sleep(Duration::from_millis(250)).await;
                        }
                    },
                    Err(error) => {
                        errors += 1;
                        error_this_packet = true;
                        last_error = Some(error.to_string());
                        let _ =
                            app.emit("motu://meter-error", last_error.clone().unwrap_or_default());
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                }

                let report_elapsed = last_report.elapsed();
                if report_elapsed >= Duration::from_secs(1) || error_this_packet {
                    let packets_per_second =
                        packets_since_report as f32 / report_elapsed.as_secs_f32().max(0.001);
                    let _ = app.emit(
                        "motu://meter-stats",
                        MotuMeterStats {
                            packets,
                            errors,
                            packets_per_second,
                            last_latency_ms,
                            last_error: last_error.clone(),
                        },
                    );
                    packets_since_report = 0;
                    last_report = Instant::now();
                }

                let elapsed = started.elapsed();
                if elapsed < frame_interval {
                    tokio::time::sleep(frame_interval - elapsed).await;
                }
            }
        });
    }

    Ok(())
}

#[tauri::command]
fn stop_motu_meter_stream(state: State<AppState>) -> AppResult<()> {
    let mut meter_stop = state
        .meter_stop
        .lock()
        .map_err(|_| AppError::Message("Meter state lock poisoned".to_string()))?;
    if let Some(stop) = meter_stop.take() {
        stop.store(true, Ordering::SeqCst);
    }

    Ok(())
}

#[tauri::command]
async fn set_channel_fader(motu_ip: String, channel: u16, gain: f32) -> AppResult<()> {
    let url = format!("{motu_ip}/datastore/mix/chan/{channel}/matrix/fader");
    let mut form = HashMap::new();
    form.insert("json", json!({ "value": gain }).to_string());

    Client::new()
        .patch(url)
        .form(&form)
        .send()
        .await?
        .error_for_status()?;

    Ok(())
}

#[tauri::command]
async fn set_channels_from_knob(
    motu_ip: String,
    channels: Vec<u16>,
    knob_position: i16,
) -> AppResult<f32> {
    let gain = knob_position_to_gain(knob_position);

    for channel in channels {
        set_channel_fader(motu_ip.clone(), channel, gain).await?;
    }

    Ok(gain)
}

#[tauri::command]
fn knob_position_to_percent(position: i16) -> i16 {
    let db = (position.clamp(0, 60) as f32 / 60.0) * 72.0 - 60.0;
    if db <= 0.0 {
        (((db + 60.0) / 60.0) * 100.0).round() as i16
    } else {
        (100.0 + (db / 12.0) * 20.0).round() as i16
    }
}

#[tauri::command]
fn fader_percent_from_linear(value: f32) -> i16 {
    fader_linear_to_percent(value)
}

fn show_menu_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        log_position("show_menu_window: start");
        log_window_snapshot("show_menu_window before show", &window);
        let show_result = window.show();
        log_position(format!("show_menu_window: show_result={show_result:?}"));
        let _ = app.emit("app://menu-visible", true);
        log_window_snapshot("show_menu_window after show", &window);
        let focus_result = window.set_focus();
        log_position(format!("show_menu_window: focus_result={focus_result:?}"));
        log_window_snapshot("show_menu_window after focus", &window);
    } else {
        log_position("show_menu_window: main window not found");
    }
}

fn position_menu_window(app: &tauri::AppHandle, tray_rect: Rect) {
    if let Some(window) = app.get_webview_window("main") {
        log_position(format!(
            "position_menu_window: start tray_rect position={:?} size={:?}",
            tray_rect.position, tray_rect.size
        ));
        log_window_snapshot("position_menu_window before", &window);
        let scale_factor = window.scale_factor().unwrap_or(1.0);
        let tray_position = tray_rect.position.to_physical::<i32>(scale_factor);
        let tray_size = tray_rect.size.to_physical::<u32>(scale_factor);
        log_position(format!(
            "position_menu_window: scale_factor={scale_factor} tray_position={tray_position:?} tray_size={tray_size:?}"
        ));

        match window.outer_size() {
            Ok(window_size) => {
                let gap = 0;
                let tray_center_x = tray_position.x + (tray_size.width as i32 / 2);
                let tray_center_y = tray_position.y + (tray_size.height as i32 / 2);
                let mut x = tray_center_x - (window_size.width as i32 / 2);
                let mut y = tray_position.y + tray_size.height as i32 + gap;
                log_position(format!(
                "position_menu_window: initial window_size={window_size:?} tray_center=({tray_center_x},{tray_center_y}) computed=({x},{y})"
            ));

                let monitor = monitor_containing_physical_point(app, tray_center_x, tray_center_y)
                    .or_else(|| window.primary_monitor().ok().flatten());

                if let Some(monitor) = monitor {
                    let work_area = monitor.work_area();
                    let min_x = work_area.position.x;
                    let min_y = work_area.position.y;
                    let max_x = min_x + work_area.size.width as i32 - window_size.width as i32;
                    let max_y = min_y + work_area.size.height as i32 - window_size.height as i32;
                    log_position(format!(
                    "position_menu_window: monitor name={:?} pos={:?} size={:?} work_area={work_area:?} scale={} clamp_x=({min_x},{max_x}) clamp_y=({min_y},{max_y})",
                    monitor.name(),
                    monitor.position(),
                    monitor.size(),
                    monitor.scale_factor()
                ));

                    if max_x >= min_x {
                        x = x.clamp(min_x, max_x);
                    }
                    if max_y >= min_y {
                        y = y.clamp(min_y, max_y);
                    }
                } else {
                    log_position("position_menu_window: monitor lookup returned none");
                }

                log_position(format!(
                    "position_menu_window: final set_position=({x},{y})"
                ));
                let set_position_result = window.set_position(PhysicalPosition::new(x, y));
                log_position(format!(
                    "position_menu_window: set_position_result={set_position_result:?}"
                ));
                log_window_snapshot("position_menu_window after set_position", &window);
            }
            Err(error) => log_position(format!("position_menu_window: outer_size error={error}")),
        }
    } else {
        log_position("position_menu_window: main window not found");
    }
}

#[tauri::command]
fn resize_menu_window(height: f64, app: tauri::AppHandle, state: State<AppState>) -> AppResult<()> {
    if let Some(window) = app.get_webview_window("main") {
        let scale_factor = window.scale_factor().unwrap_or(1.0);
        let current_width = window
            .outer_size()
            .map(|size| size.width as f64 / scale_factor)
            .unwrap_or(400.0);
        let tray_rect = state
            .last_tray_rect
            .lock()
            .ok()
            .and_then(|rect| rect.clone());

        let max_height = tray_rect
            .as_ref()
            .and_then(|rect| {
                let tray_position = rect.position.to_physical::<i32>(scale_factor);
                let tray_size = rect.size.to_physical::<u32>(scale_factor);
                let tray_center_x = tray_position.x + (tray_size.width as i32 / 2);
                let tray_center_y = tray_position.y + (tray_size.height as i32 / 2);
                monitor_containing_physical_point(&app, tray_center_x, tray_center_y).map(
                    |monitor| {
                        let work_area = monitor.work_area();
                        (work_area.size.height as f64 / monitor.scale_factor()).max(320.0)
                    },
                )
            })
            .unwrap_or(900.0);

        let next_height = height.ceil().clamp(320.0, max_height.min(900.0));
        log_position(format!(
            "resize_menu_window: requested_height={height} current_width={current_width} next_height={next_height} max_height={max_height} has_tray_rect={}",
            tray_rect.is_some()
        ));
        log_window_snapshot("resize_menu_window before set_size", &window);
        let set_size_result = window.set_size(LogicalSize::new(current_width, next_height));
        log_position(format!(
            "resize_menu_window: set_size_result={set_size_result:?}"
        ));
        set_size_result?;
        log_window_snapshot("resize_menu_window after set_size", &window);

        if let Some(rect) = tray_rect {
            position_menu_window(&app, rect);
            log_window_snapshot("resize_menu_window after reanchor", &window);
        }
    } else {
        log_position("resize_menu_window: main window not found");
    }

    Ok(())
}

fn toggle_menu_window_at_tray(app: &tauri::AppHandle, tray_rect: Rect) {
    log_position(format!(
        "toggle_menu_window_at_tray: start tray_rect position={:?} size={:?}",
        tray_rect.position, tray_rect.size
    ));
    if let Some(window) = app.get_webview_window("main") {
        log_window_snapshot("toggle before visibility check", &window);
        if window.is_visible().unwrap_or(false) {
            log_position("toggle_menu_window_at_tray: window visible, hiding");
            let hide_result = window.hide();
            log_position(format!(
                "toggle_menu_window_at_tray: hide_result={hide_result:?}"
            ));
            let _ = app.emit("app://menu-visible", false);
            log_window_snapshot("toggle after hide", &window);
        } else {
            log_position("toggle_menu_window_at_tray: window hidden, showing");
            position_menu_window(app, tray_rect);
            let show_result = window.show();
            log_position(format!(
                "toggle_menu_window_at_tray: show_result={show_result:?}"
            ));
            let _ = app.emit("app://menu-visible", true);
            log_window_snapshot("toggle after show", &window);
            let focus_result = window.set_focus();
            log_position(format!(
                "toggle_menu_window_at_tray: focus_result={focus_result:?}"
            ));
            log_window_snapshot("toggle after focus before reanchor", &window);
            position_menu_window(app, tray_rect);
            log_window_snapshot("toggle after immediate reanchor", &window);

            let app = app.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(80));
                if let Some(window) = app.get_webview_window("main") {
                    log_window_snapshot("delayed reanchor before visibility check", &window);
                    if window.is_visible().unwrap_or(false) {
                        log_position("delayed reanchor: window visible, repositioning");
                        position_menu_window(&app, tray_rect);
                        log_window_snapshot("delayed reanchor after reposition", &window);
                    } else {
                        log_position("delayed reanchor: window not visible, skipped");
                    }
                } else {
                    log_position("delayed reanchor: main window not found");
                }
            });
        }
    } else {
        log_position("toggle_menu_window_at_tray: main window not found");
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            list_serial_ports,
            connect_nano,
            disconnect_nano,
            send_nano_json,
            sync_profiles,
            get_channel_fader,
            discover_motu_tracks,
            get_motu_mix_levels,
            start_motu_meter_stream,
            stop_motu_meter_stream,
            set_channel_fader,
            set_channels_from_knob,
            knob_position_to_percent,
            fader_percent_from_linear,
            resize_menu_window,
            get_start_on_login,
            set_start_on_login,
            quit_app
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    WindowEvent::Resized(size) => {
                        log_position(format!("window_event: Resized size={size:?}"));
                        log_native_window_snapshot("window_event Resized snapshot", window);
                    }
                    WindowEvent::Moved(position) => {
                        log_position(format!("window_event: Moved position={position:?}"));
                        log_native_window_snapshot("window_event Moved snapshot", window);
                    }
                    WindowEvent::CloseRequested { api, .. } => {
                        log_position("window_event: CloseRequested");
                        log_native_window_snapshot("window_event CloseRequested before hide", window);
                        api.prevent_close();
                        let hide_result = window.hide();
                        log_position(format!(
                            "window_event: CloseRequested hide_result={hide_result:?}"
                        ));
                        let _ = window.emit("app://menu-visible", false);
                        log_native_window_snapshot("window_event CloseRequested after hide", window);
                    }
                    WindowEvent::Destroyed => {
                        log_position("window_event: Destroyed");
                    }
                    WindowEvent::Focused(focused) => {
                        log_position(format!("window_event: Focused focused={focused}"));
                        log_native_window_snapshot("window_event Focused snapshot", window);
                        if !focused {
                            let hide_result = window.hide();
                            log_position(format!(
                                "window_event: Focused(false) hide_result={hide_result:?}"
                            ));
                            let _ = window.emit("app://menu-visible", false);
                            log_native_window_snapshot("window_event Focused(false) after hide", window);
                        }
                    }
                    WindowEvent::ScaleFactorChanged {
                        scale_factor,
                        new_inner_size,
                        ..
                    } => {
                        log_position(format!(
                            "window_event: ScaleFactorChanged scale_factor={scale_factor} new_inner_size={new_inner_size:?}"
                        ));
                        log_native_window_snapshot("window_event ScaleFactorChanged snapshot", window);
                    }
                    WindowEvent::ThemeChanged(theme) => {
                        log_position(format!("window_event: ThemeChanged theme={theme:?}"));
                        log_native_window_snapshot("window_event ThemeChanged snapshot", window);
                    }
                    other => {
                        log_position(format!("window_event: other={other:?}"));
                        log_native_window_snapshot("window_event other snapshot", window);
                    }
                }
            }
        })
        .setup(|app| {
            reset_position_log();
            log_position("setup: start");
            log_monitors(app.handle(), "setup");
            app.set_activation_policy(ActivationPolicy::Accessory);
            log_position("setup: set_activation_policy Accessory");
            if let Some(window) = app.get_webview_window("main") {
                log_window_snapshot("setup initial main window", &window);
            } else {
                log_position("setup: main window not found");
            }

            let show_item =
                MenuItem::with_id(app, "show", "Show MOTU Controller", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "Quit MOTU Controller", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;
            let tray_icon = tauri::image::Image::from_bytes(TRAY_ICON_BYTES)?;

            TrayIconBuilder::with_id("motu-controller")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("MOTU Controller")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        log_position("menu_event: show");
                        show_menu_window(app);
                    }
                    "quit" => {
                        log_position("menu_event: quit");
                        app.exit(0);
                    }
                    id => log_position(format!("menu_event: unhandled id={id}")),
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        rect,
                        button,
                        button_state,
                        position,
                        ..
                    } = event
                    {
                        log_position(format!(
                            "tray_event: Click position={position:?} rect_position={:?} rect_size={:?} button={button:?} button_state={button_state:?}",
                            rect.position, rect.size
                        ));
                        if matches!(button, MouseButton::Left)
                            && matches!(button_state, MouseButtonState::Up)
                        {
                            log_monitors(tray.app_handle(), "tray_event");
                            if let Ok(mut last_tray_rect) =
                                tray.app_handle().state::<AppState>().last_tray_rect.lock()
                            {
                                *last_tray_rect = Some(rect.clone());
                            }
                            toggle_menu_window_at_tray(tray.app_handle(), rect);
                        }
                    }
                })
                .build(app)?;

            log_position("setup: tray built");
            let emit_result = app.handle().emit("app://ready", ());
            log_position(format!("setup: ready emit_result={emit_result:?}"));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
