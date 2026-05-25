import { apiClient } from "./client";
import { authStorage } from "@/lib/storage/auth-storage";
import type {
  AuthBootstrapStatusResponse,
  LoginResponse,
  MeResponse,
} from "./types";

export interface LoginInput {
  localPassphrase?: string;
  email?: string;
  password?: string;
}

export async function login(input: LoginInput): Promise<LoginResponse> {
  const data = await apiClient.post<LoginInput, LoginResponse>(
    "/v1/auth/login",
    input,
  );

  authStorage.setTokens(data.accessToken, data.refreshToken, data.expiresInSec);
  authStorage.setUser(data.user);

  return data;
}

export async function fetchMe(): Promise<MeResponse> {
  return apiClient.get<MeResponse>("/v1/auth/me");
}

export async function getBootstrapStatus(): Promise<AuthBootstrapStatusResponse> {
  return apiClient.get<AuthBootstrapStatusResponse>("/v1/auth/bootstrap/status");
}

export async function logout(): Promise<void> {
  const refreshToken = authStorage.getRefreshToken();
  try {
    await apiClient.post("/v1/auth/logout", { refreshToken });
  } catch {
    // Best-effort
  }
  authStorage.clear();
}
