export function parsePorcelain(text: string): { branch: string | null; ahead: number; behind: number; dirty_files: number } {
  let branch: string | null = null, ahead = 0, behind = 0, dirty_files = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) { const name = line.slice(14); branch = name === '(detached)' ? null : name; }
    const ab = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
    if (ab) { ahead = Number(ab[1]); behind = Number(ab[2]); }
    if (/^[12u?] /.test(line)) dirty_files++;
  }
  return { branch, ahead, behind, dirty_files };
}
export function repoFromRemote(remote: string, owner: string): string | null {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/]+)\/([^/\s]+?)\/?$/.exec(remote.trim());
  return match && match[1].toLowerCase() === owner.toLowerCase() ? match[2].replace(/\.git$/, '') : null;
}
