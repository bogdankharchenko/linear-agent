/**
 * Branch name generation utilities
 */

/**
 * Generate a branch name from a Linear issue identifier
 * Sanitizes the identifier for use in git branch names
 */
export function generateBranchName(identifier: string): string {
  const sanitized = identifier.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `agent/${sanitized}`;
}

/**
 * Find the next available branch name by checking existing branches
 * Returns the first available branch name: agent/ABC-123, agent/ABC-123-2, etc.
 */
export async function findAvailableBranchName(
  identifier: string,
  existingBranches: string[]
): Promise<string> {
  const baseName = generateBranchName(identifier);

  // Check if base name is available
  if (!existingBranches.includes(baseName)) {
    return baseName;
  }

  // Find the next available suffix
  let suffix = 2;
  while (existingBranches.includes(`${baseName}-${suffix}`)) {
    suffix++;
  }

  return `${baseName}-${suffix}`;
}

