// **試験用のソフトのパスキー認証器**（WebAuthn の none attestation・ES256）。本物の端末の代わりに、
// 登録と署名の応答を作る。試験からだけ使う（本番のコードからは読まない）。

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64u = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("base64url");

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  private signCount = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.x = Buffer.from(jwk.x!, "base64url");
    this.y = Buffer.from(jwk.y!, "base64url");
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** `navigator.credentials.create()` の応答（JSON 形）。`origin` は署名したページのオリジン */
  register(options: { challenge: string; rp: { id?: string } }, origin: string, rpId = options.rp.id!): unknown {
    const clientDataJSON = this.clientData("webauthn.create", options.challenge, origin);
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(this.x)],
      [-3, new Uint8Array(this.y)],
    ]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      createHash("sha256").update(rpId).digest(),
      Buffer.from([0x01 | 0x04 | 0x40]), // UP・UV・AT
      Buffer.alloc(4),
      Buffer.alloc(16), // aaguid
      idLen,
      this.credentialId,
      Buffer.from(isoCBOR.encode(cose as never)),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** `navigator.credentials.get()` の応答（JSON 形） */
  assert(options: { challenge: string; rpId?: string }, origin: string, rpId = options.rpId!): unknown {
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.signCount);
    const authData = Buffer.concat([createHash("sha256").update(rpId).digest(), Buffer.from([0x01 | 0x04]), count]);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]),
      this.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
    };
  }
}
