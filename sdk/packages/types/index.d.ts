/**
 * UendOS Shell 运行时类型声明
 *
 * 与 docs/shell-contract.md 及 @uendos/contract 对齐；本包只有类型，无运行时。
 */

export type CapabilityValue = '✓' | '◐' | '─' | 'web';

/** 内置能力键；插件能力以 string 形式扩展 */
export type CapabilityName =
  | 'vibrate'
  | 'share'
  | 'geolocation'
  | 'push'
  | 'haptics'
  | 'statusBar'
  | 'splash'
  | 'backButton'
  | 'openExternal'
  | 'deeplink'
  | 'network'
  | 'safeArea'
  | 'files'
  | 'camera'
  | 'biometric'
  | 'offlineQueue'
  | 'subscribeMsg'
  | 'secureStore'
  | 'identity'
  | 'iot'
  | 'iot.ble'
  | 'iot.serial'
  | 'iot.mqtt'
  | 'iot.nfc'
  | 'iot.gateway'
  | 'edge.storeRoot'
  | (string & {});

export type ShellPlatform = 'android' | 'ios' | 'mp-weixin' | 'win32' | 'darwin' | 'browser' | 'web';
export type ShellEnv = 'capacitor' | 'electron' | 'mp' | 'web';

export type ShellErrorCode =
  | 'E_BAD_ARGS'
  | 'E_UNSUPPORTED'
  | 'E_DENIED'
  | 'E_OFFLINE'
  | 'E_TIMEOUT'
  | 'E_CONFLICT'
  | 'E_RATE_LIMITED'
  | 'E_NATIVE'
  | 'E_INTERNAL';

export interface ShellResult<T = unknown> {
  ok: boolean;
  code?: ShellErrorCode;
  message?: string;
  data: T;
}

export interface ShellEventPayload<T = unknown> {
  event: string;
  seq: number;
  at: number;
  data: T | null;
}

export interface ShellCapabilities {
  [name: string]: CapabilityValue;
}

export interface ShellEnd {
  name: string;
  url: string;
}

export interface ShellPluginInfo {
  id: string;
  version: string;
  active: boolean;
}

// ---------------------------------------------------------------- IoT 契约（v0.7 M1）

export type IotQuality = 'good' | 'degraded' | 'stale' | 'unknown';
export type IotValue = string | number | boolean;
export type IotTransport = 'ble' | 'serial' | 'mqtt' | 'nfc' | 'gateway' | (string & {});

/** 所有 shell:iot-* 事件的 data 形状（信封 v1） */
export interface IotEvent {
  v: 1;
  deviceId: string;
  kind: string;
  metric: string;
  value: IotValue | null;
  unit?: string | null;
  at: number;
  seq: number;
  idem?: string | null;
  quality: IotQuality;
  source: IotTransport;
}

export interface IotDevice {
  id: string;
  kind: string;
  transport: IotTransport;
  status: 'online' | 'offline' | 'unknown';
  capabilities?: string[];
}

export interface IotReadResult {
  value: IotValue;
  unit?: string | null;
  at: number;
  quality: IotQuality;
}

export interface IotWriteParams {
  deviceId: string;
  action: string;
  params?: Record<string, unknown>;
  /** 幂等键；同一操作重放必须复用 */
  idem: string;
}

export interface IotWriteResult {
  /** 仅表示已受理，执行结果见 shell:iot-ack */
  accepted: boolean;
  ackId: string;
}

export interface IotAck {
  ok: boolean;
  code?: string;
  message?: string;
  data?: unknown;
}

/** 构建期适配器：由插件 runtime 调用 ShellCore.registerIotAdapter 注册 */
export interface IotAdapter {
  id: string;
  transport: 'ble' | 'serial' | 'mqtt' | 'nfc' | 'gateway';
  detect?: (env: ShellEnv) => boolean;
  devices?: () => IotDevice[] | Promise<IotDevice[]>;
  read?: (deviceId: string, metric: string | null) => IotReadResult | null | Promise<IotReadResult | null>;
  write?: (
    deviceId: string,
    action: string,
    params: Record<string, unknown>,
    ack: (result: IotAck) => void,
  ) => { accepted: boolean; ackId?: string; ok?: boolean } | Promise<{ accepted: boolean; ackId?: string; ok?: boolean }>;
  subscribe?: (publish: (event: Partial<IotEvent> & Pick<IotEvent, 'deviceId' | 'metric'>) => void) => void;
  /** 离线补传地址；配置后 IoT 事件进入品牌作用域队列 */
  ingestUrl?: string | null;
}

// ---------------------------------------------------------------- 安全存储（v0.8 M1）

export type SecureBackend = 'keychain' | 'keystore' | 'native' | 'memory';

export interface SecureSetResult {
  stored: boolean;
  backend: SecureBackend;
}

export interface SecureGetResult {
  value: string | null;
  backend: SecureBackend;
}

export interface SecureRemoveResult {
  removed: boolean;
  backend: SecureBackend;
}

/**
 * 构建期安全存储后端；需在 ShellCore.create 初始化完成前注册。
 * 未注册或 detect 返回 false 时回落内存（仅进程内有效）。
 */
export interface SecureStoreAdapter {
  backend: Exclude<SecureBackend, 'memory'>;
  detect?: (env: ShellEnv) => boolean;
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): boolean | Promise<boolean>;
  remove(key: string): boolean | Promise<boolean>;
}

// ---------------------------------------------------------------- 设备身份（v0.8 M2）

export type IdentityMode = 'device' | 'none';
export type IdentitySource = 'device';

/** 只返回元数据，不含设备令牌 */
export interface IdentityMeta {
  deviceId: string | null;
  owner: string | null;
  scopes: string[];
  expiresAt: string | null;
  source: IdentitySource;
}

export interface IdentityCurrentResult {
  identity: IdentityMeta | null;
  backend: SecureBackend;
}

/** 刷新成功后的元数据（事件 shell:identity-changed 的 data 同形） */
export type IdentityRefreshResult = IdentityMeta;

export interface SecurityIdentityConfig {
  /** 默认 none；device 时设备令牌只存 secureStore */
  mode?: IdentityMode;
  /** 设备令牌刷新端点（POST），mode=device 时必填 */
  endpoint?: string;
  /** 安全存储键，默认 <prefix>:identity.device */
  storeKey?: string;
}

// ---------------------------------------------------------------- 入口路由（v0.7 M1）

export type EntrySource = 'launcher' | 'deeplink' | 'scan' | 'nfc' | 'notification' | 'device';

export interface EntryParam {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  enum?: IotValue[];
  maxLength?: number;
}

export interface EntryRoute {
  /** 稳定入口标识：小写字母开头，2–32 位 */
  id: string;
  label?: string;
  /** 站内相对路径，必须以 / 开头 */
  path: string;
  params?: Record<string, EntryParam>;
  requires?: {
    capability?: CapabilityName;
    online?: boolean;
  };
  /** 校验失败或能力不足时的站内降级路径 */
  fallback?: string;
}

export interface EntryStatus extends EntryRoute {
  available: boolean;
  /** capability:<id> | offline | null */
  reason: string | null;
}

export interface EntryOpenParams {
  id: string;
  params?: Record<string, IotValue>;
  source?: EntrySource;
  /** 操作类入口必填，用于去重与对账 */
  idem?: string;
}

export interface EntryOpenResult {
  opened: boolean;
  id: string;
  path?: string;
  fallback?: string;
  reason?: string;
}

// ---------------------------------------------------------------- 桥

export interface ShellDiagnosticsEvent {
  event: string;
  seq: number;
  at: number;
}

export interface ShellDiagnostics {
  version: string;
  bridge: string;
  brand: string;
  env: ShellEnv;
  platform: ShellPlatform;
  online: boolean;
  capabilities: ShellCapabilities;
  plugins: ShellPluginInfo[];
  /** 只报后端类型与身份模式，不含键名、令牌与设备唯一码 */
  security: { secureStore: SecureBackend; identity: IdentityMode };
  queue: { count: number; oldestAt: number | null };
  /** 默认脱敏：只有 event/seq/at，不含 data */
  events: ShellDiagnosticsEvent[];
  at: number;
}

export interface Shell {
  readonly version: string;
  readonly bridge: string;
  readonly brand: string;
  readonly platform: ShellPlatform;
  readonly env: ShellEnv;
  readonly capabilities: ShellCapabilities;
  readonly ends: Record<string, ShellEnd>;
  readonly plugins?: ShellPluginInfo[];

  call<T = unknown>(method: string, args?: Record<string, unknown>): Promise<ShellResult<T>>;
  on<T = unknown>(event: string, fn: (payload: ShellEventPayload<T>) => void): () => void;

  events: {
    recent(event?: string, limit?: number): ShellEventPayload[];
  };

  /** 入口路由运行时视图 */
  entries(): EntryStatus[];
  /** 诊断快照（默认脱敏） */
  diagnostics(): ShellDiagnostics;
}

declare global {
  interface Window {
    Shell: Shell;
    ShellCore: {
      version: string;
      create(config: Record<string, unknown>): Shell;
      registerPlugin(id: string, factory: () => unknown): boolean;
      registerIotAdapter(adapter: IotAdapter): boolean;
      registerSecureStore(adapter: SecureStoreAdapter): boolean;
    };
    ziwayOS?: Shell;
    jechanOS?: Shell;
    xsoOS?: Shell;
    cajobOS?: Shell;
  }
}

export {};
