import { timingSafeEqual } from "../src/shared/guardrails";

export const ADMIN_SESSION_COOKIE = "admin_session";
export const ADMIN_SESSION_SCOPE = "admin";
export const ADMIN_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const ADMIN_REMEMBER_SECONDS = 30 * 24 * 60 * 60;
export const MAX_LOGIN_BODY_BYTES = 4 * 1024;

type SessionClaims = {
  scope: typeof ADMIN_SESSION_SCOPE;
  exp: number;
  iat: number;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

export function createAdminSessionToken(secret: string | undefined, now?: Date): Promise<string | null>;
export function createAdminSessionToken(
  secret: string | undefined,
  remember?: boolean,
  now?: Date,
): Promise<string | null>;
export async function createAdminSessionToken(
  secret: string | undefined,
  rememberOrNow: boolean | Date = false,
  maybeNow = new Date(),
): Promise<string | null> {
  if (!secret || secret.trim() === "") return null;
  const remember = typeof rememberOrNow === "boolean" ? rememberOrNow : false;
  const now = rememberOrNow instanceof Date ? rememberOrNow : maybeNow;
  const iat = Math.floor(now.getTime() / 1000);
  const claims: SessionClaims = {
    scope: ADMIN_SESSION_SCOPE,
    iat,
    exp: iat + (remember ? ADMIN_REMEMBER_SECONDS : ADMIN_SESSION_TTL_SECONDS),
  };
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${await sign(payload, secret)}`;
}

export async function verifyAdminSessionToken(
  token: string | null | undefined,
  secret: string | undefined,
  now = new Date(),
): Promise<boolean> {
  if (!token || !secret || secret.trim() === "") return false;
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) return false;
  const [payload, suppliedSignature] = parts;
  const expectedSignature = await sign(payload, secret);
  if (!timingSafeEqual(suppliedSignature, expectedSignature)) return false;
  const encodedClaims = base64UrlDecode(payload);
  if (!encodedClaims) return false;
  try {
    const claims = JSON.parse(new TextDecoder().decode(encodedClaims)) as Partial<SessionClaims>;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    return (
      claims.scope === ADMIN_SESSION_SCOPE &&
      typeof claims.iat === "number" &&
      Number.isInteger(claims.iat) &&
      typeof claims.exp === "number" &&
      Number.isInteger(claims.exp) &&
      claims.exp > nowSeconds &&
      claims.iat <= nowSeconds &&
      (claims.exp - claims.iat === ADMIN_SESSION_TTL_SECONDS ||
        claims.exp - claims.iat === ADMIN_REMEMBER_SECONDS)
    );
  } catch {
    return false;
  }
}

export function sessionTokenFromCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name === ADMIN_SESSION_COOKIE) return pair.slice(separator + 1).trim() || null;
  }
  return null;
}

export async function authorizeAdminSession(
  cookieHeader: string | null | undefined,
  secret: string | undefined,
  now = new Date(),
): Promise<boolean> {
  return verifyAdminSessionToken(sessionTokenFromCookie(cookieHeader), secret, now);
}

export function sessionSetCookie(token: string, remember: boolean): string {
  const maxAge = remember ? `; Max-Age=${ADMIN_REMEMBER_SECONDS}` : "";
  return `${ADMIN_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict${maxAge}`;
}
