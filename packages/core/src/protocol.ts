/** Client-hub protocol (API v1). */

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_MIN = 1;
export const PROTOCOL_MAX = 1;

export const HEADER_PROTOCOL = 'rembo-protocol';
export const HEADER_PROTOCOL_MIN = 'rembo-protocol-min';
export const HEADER_PROTOCOL_MAX = 'rembo-protocol-max';

export const LIMITS = {
  objectBytes: 1 << 20,
  requestBytes: 16 << 20,
  batchItems: 500,
  changesPage: 500,
} as const;

export const OBJECT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const VAULT_ID_RE = /^[0-9a-f]{32}$/;

export interface HealthResponse {
  ok: true;
  protocol: { min: number; max: number };
}

export interface RegisterRequest {
  name: string;
  platform: string;
}

export interface VaultInfo {
  id: string;
  encryption: boolean;
  keyringVersion: number;
}

export interface RegisterResponse {
  deviceId: string;
  token: string;
  accountId: string;
  vaults: VaultInfo[];
}

export interface CreateVaultRequest {
  id: string;
  encryption: boolean;
  keyring: string; // base64url
}

export interface KeyringResponse {
  keyring: string; // base64url
  version: number;
}

export interface PutItem {
  id: string;
  data: string; // base64url envelope
}

export interface PutResult {
  id: string;
  status: 'created' | 'exists';
  seq: number;
}

export interface ChangeRecord {
  seq: number;
  id: string;
  kind: 'put' | 'tombstone';
  data?: string; // base64url envelope (puts)
  device: string | null;
  at: string;
}

export interface ChangesResponse {
  records: ChangeRecord[];
  head: number;
  more: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  role: 'full' | 'read-only';
  createdAt: string;
  lastSeen: string | null;
  revoked: boolean;
  current: boolean;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}
