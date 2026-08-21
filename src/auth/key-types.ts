export interface KeyMetadata {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface VerifiedKey extends KeyMetadata {}

export interface CreatedKey {
  key: string;
  metadata: KeyMetadata;
}

export interface CreateKeyOptions {
  expiresAt?: Date;
}

export interface StoredKeyRecord extends KeyMetadata {
  salt: string;
  hash: string;
}

export interface StoredKeyFile {
  version: 1;
  keys: StoredKeyRecord[];
}
