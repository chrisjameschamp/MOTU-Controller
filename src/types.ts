export type Profile = {
  name: string;
  desc: string;
  channel: number[];
  level: number;
};

export type AppConfig = {
  motu_ip: string;
  live_meters: boolean;
  meter_refresh_hz: number;
  profiles: Profile[];
};

export type SerialPortInfo = {
  path: string;
  name: string | null;
  serial_number: string | null;
  vendor_id: string | null;
  product_id: string | null;
};

export type MotuTrack = {
  channel: number;
  name: string;
  fader: number;
  percent: number;
  format: string;
  channel_count: number;
  kind: string;
};

export type MotuMeterLevels = {
  levels: Record<string, number>;
  frame_count: number;
};

export type MotuMeterStats = {
  packets: number;
  errors: number;
  packets_per_second: number;
  last_latency_ms: number;
  last_error: string | null;
};

export type NanoEvent = {
  line: string;
  json?: Record<string, unknown>;
};
