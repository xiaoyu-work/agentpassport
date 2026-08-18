import type { EncryptedEnvelope, Keyring } from '@agentpassport/crypto';

export interface RemoteProfile {
  envelope: EncryptedEnvelope;
  /**
   * The data key, wrapped under the user's passphrase.
   *
   * This is what makes a second device possible at all: without it, every machine would
   * invent its own key and no machine could read another's profile. It is ciphertext to
   * the server, which never learns the passphrase and so can never unwrap it.
   */
  keyring: Keyring;
  revision: number;
  updatedAt: string;
}

/**
 * The sync server's entire interface.
 *
 * It moves opaque envelopes and nothing else. The server cannot read a profile, cannot
 * merge one, and cannot tell two users' preferences apart — which is what allows the
 * threat model to assume the server is eventually compromised.
 */
export interface RemoteStore {
  pull(userId: string): Promise<RemoteProfile | undefined>;
  push(userId: string, envelope: EncryptedEnvelope, keyring: Keyring): Promise<RemoteProfile>;
}

export class HttpRemoteStore implements RemoteStore {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async pull(userId: string): Promise<RemoteProfile | undefined> {
    const response = await this.fetchImpl(this.url(userId), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`pull failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as RemoteProfile;
  }

  async push(
    userId: string,
    envelope: EncryptedEnvelope,
    keyring: Keyring,
  ): Promise<RemoteProfile> {
    const response = await this.fetchImpl(this.url(userId), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ envelope, keyring }),
    });
    if (response.status === 409) {
      throw new ConflictError('the cloud profile moved on; pull and merge before pushing');
    }
    if (!response.ok) throw new Error(`push failed: ${response.status} ${await response.text()}`);
    return (await response.json()) as RemoteProfile;
  }

  private url(userId: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/v1/profiles/${encodeURIComponent(userId)}`;
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * Stand-in used when no server is configured.
 *
 * `agentpass` must be fully useful before any account exists, so local-only is a supported
 * mode rather than a degraded one.
 */
export class NullRemoteStore implements RemoteStore {
  async pull(): Promise<RemoteProfile | undefined> {
    return undefined;
  }

  async push(
    _userId: string,
    envelope: EncryptedEnvelope,
    keyring: Keyring,
  ): Promise<RemoteProfile> {
    return { envelope, keyring, revision: envelope.revision, updatedAt: envelope.updatedAt };
  }
}
