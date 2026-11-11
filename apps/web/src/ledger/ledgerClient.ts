/**
 * Browser Ledger NEAR client (WebHID), aligned with @near-wallet-selector/ledger.
 * Never requests seed phrases or exports private keys.
 */
import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import type Transport from "@ledgerhq/hw-transport";
import { baseEncode } from "@near-js/utils";
import { Buffer } from "buffer";

export const DEFAULT_DERIVATION_PATH = "44'/397'/0'/0'/1'";

const CLA = 0x80;
enum NEAR_INS {
  GET_VERSION = 0x06,
  GET_PUBLIC_KEY = 0x04,
  SIGN_TRANSACTION = 0x02,
  /** NEP-413 off-chain message (NEAR Ledger app ≥2.1). */
  SIGN_NEP413_MESSAGE = 0x07,
}
const P1_LAST = 0x80;
const P1_MORE = 0x00;
const P1_IGNORE = 0x00;
const P2_IGNORE = 0x00;
const CHUNK_SIZE = 250;
const networkId = "W".charCodeAt(0);

export function isLedgerSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!(navigator as Navigator & { hid?: unknown }).hid
  );
}

function parseDerivationPath(derivationPath: string): Buffer {
  const parts = derivationPath.split("/");
  return Buffer.concat(
    parts
      .map((part) =>
        part.endsWith("'")
          ? Math.abs(parseInt(part.slice(0, -1), 10)) | 0x80000000
          : Math.abs(parseInt(part, 10))
      )
      .map((i32) =>
        Buffer.from([
          (i32 >> 24) & 0xff,
          (i32 >> 16) & 0xff,
          (i32 >> 8) & 0xff,
          i32 & 0xff,
        ])
      )
  );
}

export function mapLedgerError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("hid") && lower.includes("not")) {
    return "WebHID unsupported — use Chrome or Edge on desktop.";
  }
  if (lower.includes("user denied") || lower.includes("denied by the user") || lower.includes("access denied")) {
    return "Device access denied or user cancelled the browser permission prompt.";
  }
  if (lower.includes("locked") || lower.includes("0x5515") || lower.includes("0x6b0c")) {
    return "Ledger is locked — unlock the device and open the NEAR app.";
  }
  // 0x6e01 CLA_NOT_SUPPORTED_BOOTLOADER: dashboard / bootloader / wrong app — NEAR CLA 0x80 rejected
  if (
    lower.includes("0x6e01") ||
    lower.includes("cla_not_supported") ||
    lower.includes("bootloader")
  ) {
    return "Ledger answered from dashboard/bootloader (or wrong app), not NEAR. Unlock → open the NEAR app until you see its home screen → then Connect again. Do not stay on the Ledger main menu.";
  }
  if (
    lower.includes("app does not seem to be open") ||
    lower.includes("0x6e00") ||
    lower.includes("unknown status 0x6d00") ||
    lower.includes("0x6d00")
  ) {
    return "NEAR app is not open on the Ledger — open the NEAR app and retry.";
  }
  if (lower.includes("0x6985") || lower.includes("conditions of use not satisfied")) {
    return "Rejected on the Ledger device (transaction or NEP-413 message).";
  }
  if (lower.includes("no device selected") || lower.includes("cannot find device")) {
    return "No Ledger selected — plug in via USB and choose the device.";
  }
  if (lower.includes("device is already open") || lower.includes("already open")) {
    return "Ledger already claimed by another tab/app — close Ledger Live and other Ledger tabs, then retry.";
  }
  return msg.slice(0, 280);
}

export class LedgerClient {
  private transport: Transport | null = null;

  isConnected(): boolean {
    return Boolean(this.transport);
  }

  async connect(): Promise<void> {
    if (!isLedgerSupported()) {
      throw new Error("WebHID unsupported — use Chrome or Edge on desktop.");
    }
    this.transport = await TransportWebHID.create();
    const handleDisconnect = () => {
      this.transport?.off("disconnect", handleDisconnect);
      this.transport = null;
    };
    this.transport.on("disconnect", handleDisconnect);
  }

  async disconnect(): Promise<void> {
    if (!this.transport) return;
    await this.transport.close();
    this.transport = null;
  }

  async getVersion(): Promise<string> {
    if (!this.transport) throw new Error("Device not connected");
    const res = await this.transport.send(CLA, NEAR_INS.GET_VERSION, P1_IGNORE, P2_IGNORE);
    const [major, minor, patch] = Array.from(res);
    return `${major}.${minor}.${patch}`;
  }

  /** Returns base58 public key material (without ed25519: prefix). */
  async getPublicKey(derivationPath: string): Promise<string> {
    if (!this.transport) throw new Error("Device not connected");
    const res = await this.transport.send(
      CLA,
      NEAR_INS.GET_PUBLIC_KEY,
      P2_IGNORE,
      networkId,
      parseDerivationPath(derivationPath)
    );
    return baseEncode(new Uint8Array(res.subarray(0, -2)));
  }

  async signTransaction(data: Uint8Array, derivationPath: string): Promise<Buffer> {
    if (!this.transport) throw new Error("Device not connected");
    await this.getVersion();
    const allData = Buffer.concat([parseDerivationPath(derivationPath), Buffer.from(data)]);
    for (let offset = 0; offset < allData.length; offset += CHUNK_SIZE) {
      const isLastChunk = offset + CHUNK_SIZE >= allData.length;
      const response = await this.transport.send(
        CLA,
        NEAR_INS.SIGN_TRANSACTION,
        isLastChunk ? P1_LAST : P1_MORE,
        P2_IGNORE,
        Buffer.from(allData.subarray(offset, offset + CHUNK_SIZE))
      );
      if (isLastChunk) {
        return Buffer.from(response.subarray(0, -2));
      }
    }
    throw new Error("Invalid data or derivation path");
  }

  /**
   * Sign a NEP-413 Borsh payload on device (INS 0x07).
   * `payload` must be borsh(NEP413Payload) — NOT the SHA-256 hash (device hashes).
   * Requires NEAR Ledger app with NEP-413 support; approve on the physical device.
   */
  async signNep413Message(
    payload: Uint8Array,
    derivationPath: string
  ): Promise<Uint8Array> {
    if (!this.transport) throw new Error("Device not connected");
    const version = await this.getVersion();
    const [major, minor] = version.split(".").map((x) => Number(x));
    if ((major ?? 0) < 2 || ((major ?? 0) === 2 && (minor ?? 0) < 1)) {
      throw new Error(
        `NEAR Ledger app ${version} cannot sign NEP-413 messages. Update the NEAR app to ≥2.1, then retry.`
      );
    }
    const allData = Buffer.concat([
      parseDerivationPath(derivationPath),
      Buffer.from(payload),
    ]);
    for (let offset = 0; offset < allData.length; offset += CHUNK_SIZE) {
      const isLastChunk = offset + CHUNK_SIZE >= allData.length;
      const response = await this.transport.send(
        CLA,
        NEAR_INS.SIGN_NEP413_MESSAGE,
        isLastChunk ? P1_LAST : P1_MORE,
        networkId,
        Buffer.from(allData.subarray(offset, offset + CHUNK_SIZE))
      );
      if (isLastChunk) {
        return new Uint8Array(response.subarray(0, -2));
      }
    }
    throw new Error("Invalid NEP-413 payload or derivation path");
  }
}
