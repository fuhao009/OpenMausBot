export interface EncryptedRecordStore {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}
export interface EncryptedRecordEncryption {
  available(): boolean | Promise<boolean>;
  encrypt(value: string): Buffer | Promise<Buffer>;
  /** A string, or Electron 43's { shouldReEncrypt, result } (safeStorage.decryptStringAsync). */
  decrypt(value: Buffer): string | { result: string } | Promise<string | { result: string }>;
}
export declare function createEncryptedRecordStore(options: {
  file: string;
  encryption: EncryptedRecordEncryption;
}): EncryptedRecordStore;
/** True only for a record that can never be read again; a locked keychain is not this. */
export declare function unreadableRecord(error: unknown): boolean;
