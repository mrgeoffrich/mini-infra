// ====================
// NATS Types
// ====================

export type NatsRetentionPolicy = "limits" | "interest" | "workqueue";
export type NatsStorageType = "file" | "memory";
export type NatsDeliverPolicy = "all" | "last" | "new" | "by_start_sequence" | "by_start_time" | "last_per_subject";
export type NatsAckPolicy = "none" | "all" | "explicit";

export interface NatsStatus {
  configured: boolean;
  reachable: boolean;
  clientUrl: string | null;
  monitorUrl: string | null;
  stackId: string | null;
  bootstrappedAt: string | null;
  lastAppliedAt: string | null;
  operatorPublic: string | null;
  systemAccountPublic: string | null;
  accounts: number;
  credentialProfiles: number;
  streams: number;
  consumers: number;
  errorMessage?: string;
}

export interface NatsAccountInfo {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  seedKvPath: string;
  publicKey: string | null;
  jwt: string | null;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NatsCredentialProfileInfo {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  accountId: string;
  accountName: string;
  publishAllow: string[];
  subscribeAllow: string[];
  ttlSeconds: number;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NatsStreamInfo {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  description: string | null;
  subjects: string[];
  retention: NatsRetentionPolicy;
  storage: NatsStorageType;
  maxMsgs: number | null;
  maxBytes: number | null;
  maxAgeSeconds: number | null;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NatsConsumerInfo {
  id: string;
  streamId: string;
  streamName: string;
  name: string;
  durableName: string | null;
  description: string | null;
  filterSubject: string | null;
  deliverPolicy: NatsDeliverPolicy;
  ackPolicy: NatsAckPolicy;
  maxDeliver: number | null;
  ackWaitSeconds: number | null;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNatsAccountRequest {
  name: string;
  displayName: string;
  description?: string;
}

export interface UpdateNatsAccountRequest {
  displayName?: string;
  description?: string | null;
}

export interface CreateNatsCredentialProfileRequest {
  name: string;
  displayName: string;
  description?: string;
  accountId: string;
  publishAllow: string[];
  subscribeAllow: string[];
  ttlSeconds?: number;
}

export interface UpdateNatsCredentialProfileRequest {
  displayName?: string;
  description?: string | null;
  accountId?: string;
  publishAllow?: string[];
  subscribeAllow?: string[];
  ttlSeconds?: number;
}

export interface CreateNatsStreamRequest {
  name: string;
  accountId: string;
  description?: string;
  subjects: string[];
  retention?: NatsRetentionPolicy;
  storage?: NatsStorageType;
  maxMsgs?: number | null;
  maxBytes?: number | null;
  maxAgeSeconds?: number | null;
}

export interface UpdateNatsStreamRequest {
  accountId?: string;
  description?: string | null;
  subjects?: string[];
  retention?: NatsRetentionPolicy;
  storage?: NatsStorageType;
  maxMsgs?: number | null;
  maxBytes?: number | null;
  maxAgeSeconds?: number | null;
}

export interface CreateNatsConsumerRequest {
  streamId: string;
  name: string;
  durableName?: string;
  description?: string;
  filterSubject?: string;
  deliverPolicy?: NatsDeliverPolicy;
  ackPolicy?: NatsAckPolicy;
  maxDeliver?: number | null;
  ackWaitSeconds?: number | null;
}

export interface UpdateNatsConsumerRequest {
  streamId?: string;
  durableName?: string | null;
  description?: string | null;
  filterSubject?: string | null;
  deliverPolicy?: NatsDeliverPolicy;
  ackPolicy?: NatsAckPolicy;
  maxDeliver?: number | null;
  ackWaitSeconds?: number | null;
}

export interface MintNatsCredentialResponse {
  profileId: string;
  profileName: string;
  expiresAt: string | null;
  creds: string;
}

export interface NatsAppliedEvent {
  operationId: string;
  success: boolean;
  message?: string;
}
