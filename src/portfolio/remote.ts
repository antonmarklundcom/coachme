import type { Exec } from '../lib/exec.js';
import { discoveryPaths, type DiscoveryInput } from './discover.js';

// Repository and file aliases are positional; external names are GraphQL string literals.
export async function gatherRemoteFiles(exec: Exec, owner: string, repos: {name: string; homepageUrl?: string | null}[]): Promise<DiscoveryInput[]> {
  const result: DiscoveryInput[] = [];
  for (let offset = 0; offset < repos.length; offset += 20) {
    const batch = repos.slice(offset, offset + 20);
    const query = `query { ${batch.map((repo,i) => `r${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo.name)}) { ${discoveryPaths.map((path,j) => `f${j}: object(expression:${JSON.stringify(`HEAD:${path}`)}) { ... on Blob { text } }`).join('\n')} }`).join('\n')} }`;
    const response = JSON.parse(await exec('gh', ['api','graphql','-f',`query=${query}`]));
    if (response.errors?.length || !response.data) throw new Error('Remote domain discovery query failed');
    batch.forEach((repo,i) => {
      const blobs = response.data[`r${i}`];
      if (!blobs) throw new Error('Remote domain discovery repository missing');
      const files: Record<string,string> = {};
      discoveryPaths.forEach((path,j) => { if (typeof blobs[`f${j}`]?.text === 'string') files[path] = blobs[`f${j}`].text; });
      result.push({repo:repo.name,homepageUrl:repo.homepageUrl,files});
    });
  }
  return result;
}
