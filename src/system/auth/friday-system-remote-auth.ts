import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";

import type {
  FridaySystemRemotePasskey,
  FridaySystemRemotePasskeyDeviceType,
} from "../model/friday-system.types.js";

export interface FridaySystemRemoteAuthRegistrationOptionsInput {
  rpName: string;
  rpId: string;
  userId: string;
  userName: string;
  userDisplayName: string;
  excludeCredentialIds?: string[];
}

export interface FridaySystemRemoteAuthVerifiedRegistration {
  verified: boolean;
  credentialId?: string;
  publicKey?: string;
  counter?: number;
  transports?: string[];
  deviceType?: FridaySystemRemotePasskeyDeviceType;
  backedUp?: boolean;
  origin?: string;
  rpId?: string;
}

export interface FridaySystemRemoteAuthAuthenticationOptionsInput {
  rpId: string;
  credentialId: string;
  transports?: string[];
}

export interface FridaySystemRemoteAuthVerifiedAuthentication {
  verified: boolean;
  credentialId?: string;
  newCounter?: number;
  transports?: string[];
  deviceType?: FridaySystemRemotePasskeyDeviceType;
  backedUp?: boolean;
  origin?: string;
  rpId?: string;
}

export interface FridaySystemRemoteAuthAdapter {
  generateRegistrationOptions(
    input: FridaySystemRemoteAuthRegistrationOptionsInput,
  ): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
  }): Promise<FridaySystemRemoteAuthVerifiedRegistration>;
  generateAuthenticationOptions(
    input: FridaySystemRemoteAuthAuthenticationOptionsInput,
  ): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    passkey: FridaySystemRemotePasskey;
  }): Promise<FridaySystemRemoteAuthVerifiedAuthentication>;
}

function encodeUint8ArrayToBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64UrlToUint8Array(value: string): WebAuthnCredential["publicKey"] {
  return new Uint8Array(Buffer.from(value, "base64url")).slice() as WebAuthnCredential["publicKey"];
}

function normalizeTransports(
  transports: readonly string[] | undefined,
): AuthenticatorTransportFuture[] | undefined {
  return transports as AuthenticatorTransportFuture[] | undefined;
}

function toWebAuthnCredential(passkey: FridaySystemRemotePasskey): WebAuthnCredential {
  return {
    id: passkey.credentialId,
    publicKey: decodeBase64UrlToUint8Array(passkey.publicKey),
    counter: passkey.counter,
    transports: normalizeTransports(passkey.transports),
  };
}

export function createFridaySystemRemoteAuthAdapter(): FridaySystemRemoteAuthAdapter {
  return {
    async generateRegistrationOptions(input) {
      return generateRegistrationOptions({
        rpName: input.rpName,
        rpID: input.rpId,
        userName: input.userName,
        userDisplayName: input.userDisplayName,
        userID: new Uint8Array(Buffer.from(input.userId, "utf8")).slice(),
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
        excludeCredentials: (input.excludeCredentialIds ?? []).map((credentialId) => ({
          id: credentialId,
          type: "public-key",
        })),
      });
    },

    async verifyRegistration(input) {
      const verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.expectedRpId,
        requireUserVerification: true,
      });

      if (!verification.verified) {
        return { verified: false };
      }

      return {
        verified: true,
        credentialId: verification.registrationInfo.credential.id,
        publicKey: encodeUint8ArrayToBase64Url(verification.registrationInfo.credential.publicKey),
        counter: verification.registrationInfo.credential.counter,
        transports: normalizeTransports(verification.registrationInfo.credential.transports),
        deviceType: verification.registrationInfo.credentialDeviceType,
        backedUp: verification.registrationInfo.credentialBackedUp,
        origin: verification.registrationInfo.origin,
        rpId: verification.registrationInfo.rpID,
      };
    },

    async generateAuthenticationOptions(input) {
      return generateAuthenticationOptions({
        rpID: input.rpId,
        userVerification: "preferred",
        allowCredentials: [{
          id: input.credentialId,
          transports: normalizeTransports(input.transports),
        }],
      });
    },

    async verifyAuthentication(input) {
      const verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.expectedRpId,
        credential: toWebAuthnCredential(input.passkey),
        requireUserVerification: true,
      });

      if (!verification.verified) {
        return { verified: false };
      }

      return {
        verified: true,
        credentialId: verification.authenticationInfo.credentialID,
        newCounter: verification.authenticationInfo.newCounter,
        transports: normalizeTransports(input.passkey.transports),
        deviceType: verification.authenticationInfo.credentialDeviceType,
        backedUp: verification.authenticationInfo.credentialBackedUp,
        origin: verification.authenticationInfo.origin,
        rpId: verification.authenticationInfo.rpID,
      };
    },
  };
}
