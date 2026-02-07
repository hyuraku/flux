export interface KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface EncryptedData {
  ciphertext: ArrayBuffer;
  iv: Uint8Array;
}

export interface ExportedPublicKey {
  x: string; // Base64
  y: string; // Base64
}

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits for AES-GCM

export class EncryptionService {
  private keyPair: KeyPair | null = null;
  private sharedKey: CryptoKey | null = null;

  /**
   * ECDH鍵ペアを生成
   */
  async generateKeyPair(): Promise<ExportedPublicKey> {
    this.keyPair = await crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true, // extractable
      ['deriveKey']
    );

    return this.exportPublicKey(this.keyPair.publicKey);
  }

  /**
   * 公開鍵をエクスポート（JSON Web Key形式）
   */
  async exportPublicKey(publicKey: CryptoKey): Promise<ExportedPublicKey> {
    const jwk = await crypto.subtle.exportKey('jwk', publicKey);

    if (!jwk.x || !jwk.y) {
      throw new Error('Invalid public key format');
    }

    return {
      x: jwk.x,
      y: jwk.y,
    };
  }

  /**
   * 公開鍵をインポート
   */
  async importPublicKey(exported: ExportedPublicKey): Promise<CryptoKey> {
    const jwk: JsonWebKey = {
      kty: 'EC',
      crv: 'P-256',
      x: exported.x,
      y: exported.y,
    };

    return crypto.subtle.importKey(
      'jwk',
      jwk,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true,
      []
    );
  }

  /**
   * 相手の公開鍵から共有鍵を導出
   */
  async deriveSharedKey(peerPublicKey: ExportedPublicKey): Promise<void> {
    if (!this.keyPair) {
      throw new Error('Key pair not generated. Call generateKeyPair() first.');
    }

    const importedPeerKey = await this.importPublicKey(peerPublicKey);

    this.sharedKey = await crypto.subtle.deriveKey(
      {
        name: 'ECDH',
        public: importedPeerKey,
      },
      this.keyPair.privateKey,
      {
        name: ALGORITHM,
        length: KEY_LENGTH,
      },
      false, // not extractable
      ['encrypt', 'decrypt']
    );
  }

  /**
   * データを暗号化
   */
  async encrypt(data: ArrayBuffer): Promise<EncryptedData> {
    if (!this.sharedKey) {
      throw new Error('Shared key not derived. Call deriveSharedKey() first.');
    }

    // ランダムなIVを生成
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    const ciphertext = await crypto.subtle.encrypt(
      {
        name: ALGORITHM,
        iv,
      },
      this.sharedKey,
      data
    );

    return { ciphertext, iv };
  }

  /**
   * データを復号
   */
  async decrypt(encryptedData: EncryptedData): Promise<ArrayBuffer> {
    if (!this.sharedKey) {
      throw new Error('Shared key not derived. Call deriveSharedKey() first.');
    }

    // Ensure iv is a proper Uint8Array backed by ArrayBuffer
    const iv = new Uint8Array(encryptedData.iv);

    return crypto.subtle.decrypt(
      {
        name: ALGORITHM,
        iv,
      },
      this.sharedKey,
      encryptedData.ciphertext
    );
  }

  /**
   * 暗号化データをシリアライズ（送信用）
   */
  serializeEncryptedData(data: EncryptedData): ArrayBuffer {
    // フォーマット: [IV (12 bytes)] + [ciphertext]
    const result = new Uint8Array(data.iv.length + data.ciphertext.byteLength);
    result.set(data.iv, 0);
    result.set(new Uint8Array(data.ciphertext), data.iv.length);
    return result.buffer;
  }

  /**
   * シリアライズされたデータを復元
   */
  deserializeEncryptedData(buffer: ArrayBuffer): EncryptedData {
    const data = new Uint8Array(buffer);
    const iv = data.slice(0, IV_LENGTH);
    const ciphertext = data.slice(IV_LENGTH).buffer;
    return { iv, ciphertext };
  }

  /**
   * セッション終了時にキーをクリア
   */
  clearKeys(): void {
    this.keyPair = null;
    this.sharedKey = null;
  }

  /**
   * 共有鍵が確立されているか
   */
  isReady(): boolean {
    return this.sharedKey !== null;
  }
}

/**
 * シングルトンインスタンス（必要に応じて使用）
 */
export const encryptionService = new EncryptionService();
