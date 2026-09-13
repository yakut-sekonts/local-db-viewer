import { X509Certificate } from 'node:crypto';
import { checkServerIdentity, getCACertificates, rootCertificates } from 'node:tls';
import { Agent } from 'undici';
import type { Profile } from '../src/shared';

type Settings = Pick<Profile, 'sslVerification' | 'sslCa'>;
export const MAX_CA_BYTES = 256 * 1024;

export function validateCertificate(pem: string): string {
  if (typeof pem !== 'string' || Buffer.byteLength(pem, 'utf8') > MAX_CA_BYTES) throw new Error('CA bundle должен быть PEM-файлом размером до 256 KB.');
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (!certificates.length || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) throw new Error('Ожидается PEM с публичными сертификатами. Private key, JKS и PKCS#12 не поддерживаются в поле CA.');
  for (const certificate of certificates) {
    try { new X509Certificate(certificate); }
    catch { throw new Error('Некорректный X.509 сертификат в CA bundle.'); }
  }
  return certificates.join('\n') + '\n';
}

export function validateSSL(settings: Settings): void {
  if (settings.sslVerification !== undefined && !['FULL', 'CA', 'NONE'].includes(settings.sslVerification)) throw new Error('SSLVerification должен быть FULL, CA или NONE.');
  if (settings.sslCa) validateCertificate(settings.sslCa);
  else if (settings.sslCa !== undefined && typeof settings.sslCa !== 'string') throw new Error('Некорректный CA bundle.');
}

let trustedRoots: string[] | undefined;
function roots(): string[] {
  // Read OS roots as well as Node's bundle, including CA certificates installed by corporate IT.
  trustedRoots ??= [...new Set([...rootCertificates, ...getCACertificates('default'), ...getCACertificates('system')])];
  return trustedRoots;
}

export function tlsOptions(settings: Settings) {
  validateSSL(settings);
  const mode = settings.sslVerification ?? 'FULL';
  return {
    ca: settings.sslCa ? [validateCertificate(settings.sslCa)] : roots(),
    rejectUnauthorized: mode !== 'NONE',
    checkServerIdentity,
    minVersion: 'TLSv1.2' as const,
  };
}

export function httpAgent(profile: Pick<Profile, 'endpoint' | 'sslVerification' | 'sslCa'>): Agent | undefined {
  return new URL(profile.endpoint).protocol === 'https:' ? new Agent({ connect: tlsOptions(profile) }) : undefined;
}

export function connectionError(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    const message = code ? `${code}: ${current.message}` : current.message;
    if (!messages.includes(message)) messages.push(message);
    current = current.cause;
  }
  return messages.join(' · ') || String(error);
}
