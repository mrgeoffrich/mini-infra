// ====================
// Registry Credential Types
// ====================

export interface RegistryCredential {
  id: string;
  name: string;
  registryUrl: string;
  username: string;
  password: string; // Will be encrypted in DB, decrypted in memory
  isDefault: boolean;
  isActive: boolean;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
  lastValidatedAt?: Date;
  validationStatus?: 'valid' | 'invalid' | 'pending' | 'error';
  validationMessage?: string;
}

export interface CreateRegistryCredentialRequest {
  name: string;
  registryUrl: string;
  username: string;
  password: string;
  isDefault?: boolean;
  isActive?: boolean;
  description?: string;
}

export interface UpdateRegistryCredentialRequest {
  name?: string;
  username?: string;
  password?: string;
  isDefault?: boolean;
  isActive?: boolean;
  description?: string;
}

export interface RegistryCredentialResponse {
  id: string;
  name: string;
  registryUrl: string;
  username: string;
  password?: string; // Optional - only included when explicitly requested
  isDefault: boolean;
  isActive: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  validationStatus?: string;
  validationMessage?: string;
}

export interface RegistryTestResult {
  success: boolean;
  message: string;
  registryUrl: string;
  pullTimeMs?: number;
  error?: string;
}
