import type {
  AuthenticationResponseJSON,
  FridaySystemRemotePasskey,
  FridaySystemRemotePasskeyDeviceType,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
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

const NOT_IMPLEMENTED_MSG = "WebAuthn/FIDO2 support has been removed. Passkey-based remote auth is not available.";

export function createFridaySystemRemoteAuthAdapter(): FridaySystemRemoteAuthAdapter {
  return {
    async generateRegistrationOptions(_input) {
      throw new Error(NOT_IMPLEMENTED_MSG);
    },

    async verifyRegistration(_input) {
      throw new Error(NOT_IMPLEMENTED_MSG);
    },

    async generateAuthenticationOptions(_input) {
      throw new Error(NOT_IMPLEMENTED_MSG);
    },

    async verifyAuthentication(_input) {
      throw new Error(NOT_IMPLEMENTED_MSG);
    },
  };
}
