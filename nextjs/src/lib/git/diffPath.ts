export const normalizeGitRevisionPath = (filePath: string): string =>
  filePath.trim().replace(/^\/+/, "");

export const quoteGitRevision = (revision: string): string =>
  `'${revision.replace(/'/g, "'\\''")}'`;

export const buildGitShowHeadCommand = (filePath: string): string => {
  const normalizedPath = normalizeGitRevisionPath(filePath);
  return `show ${quoteGitRevision(`HEAD:${normalizedPath}`)}`;
};
