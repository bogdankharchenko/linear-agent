import { describe, it, expect } from 'vitest';
import { generateBranchName, findAvailableBranchName } from '../utils/branch';

describe('generateBranchName', () => {
  it('should convert identifier to lowercase branch name', () => {
    expect(generateBranchName('ABC-123')).toBe('agent/abc-123');
    expect(generateBranchName('PROJ-456')).toBe('agent/proj-456');
  });

  it('should handle already lowercase identifiers', () => {
    expect(generateBranchName('abc-123')).toBe('agent/abc-123');
  });

  it('should replace invalid characters with hyphens', () => {
    expect(generateBranchName('ABC_123')).toBe('agent/abc-123');
    expect(generateBranchName('ABC.123')).toBe('agent/abc-123');
    expect(generateBranchName('ABC 123')).toBe('agent/abc-123');
    expect(generateBranchName('ABC@123')).toBe('agent/abc-123');
  });

  it('should handle identifiers with multiple invalid characters', () => {
    expect(generateBranchName('ABC__123..456')).toBe('agent/abc--123--456');
  });

  it('should preserve hyphens in identifiers', () => {
    expect(generateBranchName('ABC-DEF-123')).toBe('agent/abc-def-123');
  });

  it('should handle numeric identifiers', () => {
    expect(generateBranchName('12345')).toBe('agent/12345');
  });
});

describe('findAvailableBranchName', () => {
  it('should return base name when no conflicts', async () => {
    const existingBranches = ['main', 'develop', 'feature/other'];
    const result = await findAvailableBranchName('ABC-123', existingBranches);
    expect(result).toBe('agent/abc-123');
  });

  it('should append -2 when base name exists', async () => {
    const existingBranches = ['main', 'agent/abc-123'];
    const result = await findAvailableBranchName('ABC-123', existingBranches);
    expect(result).toBe('agent/abc-123-2');
  });

  it('should append -3 when base name and -2 exist', async () => {
    const existingBranches = ['main', 'agent/abc-123', 'agent/abc-123-2'];
    const result = await findAvailableBranchName('ABC-123', existingBranches);
    expect(result).toBe('agent/abc-123-3');
  });

  it('should find next available suffix with gaps', async () => {
    // If -2 and -3 exist but not -4, should return -4
    const existingBranches = [
      'agent/abc-123',
      'agent/abc-123-2',
      'agent/abc-123-3',
    ];
    const result = await findAvailableBranchName('ABC-123', existingBranches);
    expect(result).toBe('agent/abc-123-4');
  });

  it('should handle empty branch list', async () => {
    const result = await findAvailableBranchName('XYZ-999', []);
    expect(result).toBe('agent/xyz-999');
  });

  it('should handle many existing branches', async () => {
    const existingBranches = [
      'agent/abc-123',
      'agent/abc-123-2',
      'agent/abc-123-3',
      'agent/abc-123-4',
      'agent/abc-123-5',
    ];
    const result = await findAvailableBranchName('ABC-123', existingBranches);
    expect(result).toBe('agent/abc-123-6');
  });

  it('should not be confused by similar branch names', async () => {
    const existingBranches = [
      'agent/abc-1234', // Different issue
      'agent/abc-12',   // Different issue
      'agent/abc-123x', // Invalid suffix
    ];
    const result = await findAvailableBranchName('ABC-123', existingBranches);
    expect(result).toBe('agent/abc-123');
  });
});
