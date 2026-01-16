import { describe, it, expect } from 'vitest';
import { verifyLinearSignature, verifyGitHubSignature } from '../utils/crypto';

describe('verifyLinearSignature', () => {
  const secret = 'test-webhook-secret';

  it('should verify a valid signature', async () => {
    const body = '{"type":"test","action":"created"}';

    // Generate expected signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const signature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const isValid = await verifyLinearSignature(body, signature, secret);
    expect(isValid).toBe(true);
  });

  it('should reject an invalid signature', async () => {
    const body = '{"type":"test","action":"created"}';
    const invalidSignature = 'invalid-signature-that-is-definitely-wrong';

    const isValid = await verifyLinearSignature(body, invalidSignature, secret);
    expect(isValid).toBe(false);
  });

  it('should reject a signature for different body', async () => {
    const body = '{"type":"test","action":"created"}';
    const differentBody = '{"type":"different","action":"modified"}';

    // Generate signature for different body
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(differentBody));
    const signature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const isValid = await verifyLinearSignature(body, signature, secret);
    expect(isValid).toBe(false);
  });

  it('should reject empty signature', async () => {
    const body = '{"type":"test"}';
    const isValid = await verifyLinearSignature(body, '', secret);
    expect(isValid).toBe(false);
  });
});

describe('verifyGitHubSignature', () => {
  const secret = 'github-webhook-secret';

  it('should verify a valid signature with sha256= prefix', async () => {
    const body = '{"action":"opened","number":1}';

    // Generate expected signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const hexSignature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const signature = `sha256=${hexSignature}`;

    const isValid = await verifyGitHubSignature(body, signature, secret);
    expect(isValid).toBe(true);
  });

  it('should reject signature without sha256= prefix', async () => {
    const body = '{"action":"opened"}';
    const signatureWithoutPrefix = 'abc123def456';

    const isValid = await verifyGitHubSignature(body, signatureWithoutPrefix, secret);
    expect(isValid).toBe(false);
  });

  it('should reject an invalid signature', async () => {
    const body = '{"action":"opened"}';
    const invalidSignature = 'sha256=invalid-signature';

    const isValid = await verifyGitHubSignature(body, invalidSignature, secret);
    expect(isValid).toBe(false);
  });

  it('should reject empty signature', async () => {
    const body = '{"action":"opened"}';
    const isValid = await verifyGitHubSignature(body, '', secret);
    expect(isValid).toBe(false);
  });

  it('should be timing-safe against length attacks', async () => {
    const body = '{"action":"opened"}';

    // Test with signatures of different lengths
    const shortSignature = 'sha256=abc';
    const longSignature = 'sha256=' + 'a'.repeat(1000);

    const isValidShort = await verifyGitHubSignature(body, shortSignature, secret);
    const isValidLong = await verifyGitHubSignature(body, longSignature, secret);

    expect(isValidShort).toBe(false);
    expect(isValidLong).toBe(false);
  });
});
