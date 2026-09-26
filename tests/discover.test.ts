import { it,expect } from 'vitest';
import { discoverDomains,domainHost } from '../src/portfolio/discover.js';
it('discovers every source in priority order with confidence',() => {
  const result = discoverDomains({repo:'asado-com-py',folder:'comida-com-py',homepageUrl:'https://homepage.test',files:{
    CNAME:'cname.test\n','package.json':JSON.stringify({homepage:'https://package.test'}),
    '.env.example':'PUBLIC_SITE_URL="https://env.test"',
    'next-sitemap.config.js':"module.exports = {siteUrl: 'https://sitemap.test'}",
    'src/app/layout.tsx':"const metadata = { metadataBase: new URL('https://layout.test') };",
    'app/layout.js':"const metadata = {alternates: {canonical: 'https://canonical.test'}};",
    'index.html':'<link href="https://html.test" rel="canonical"><meta content="https://og.test" property="og:url">',
  }});
  expect(result.map(d => d.host)).toEqual(['cname.test','homepage.test','package.test','env.test','sitemap.test','layout.test','canonical.test','html.test','og.test','asado.com.py','comida.com.py']);
  expect(result.map(d => d.confidence)).toEqual(['high','high','medium','medium','medium','medium','medium','medium','medium','low','low']);
  expect(result.every(d => !!d.source)).toBe(true);
});
it('ignores placeholders, hosting previews, GitHub, CDNs and credentials',() => {
  for (const host of ['localhost','example.com','sub.example.com','app.vercel.app','demo.hostingersite.com','github.com','cdn.site.test','cdn.jsdelivr.net','unpkg.com','cdnjs.com','x.cloudfront.net','fonts.googleapis.com']) expect(domainHost(`https://${host}`)).toBeNull();
  expect(domainHost('https://fake-user:fake-value@site.test')).toBeNull();
  expect(discoverDomains({repo:'plain',homepageUrl:'https://same.test',files:{CNAME:'same.test'}})).toEqual([{repo:'plain',host:'same.test',source:'CNAME',confidence:'high'}]);
});
it('reads site constants and matching README URLs without accepting unrelated links',() => {
  for (const path of ['src/lib/site.ts','src/config/site.ts','lib/site.ts']) {
    expect(discoverDomains({repo:'besikt',files:{[path]:"export const SITE_URL = 'https://besikt.se';"}})[0]).toMatchObject({host:'besikt.se',confidence:'high'});
  }
  for (const path of ['config.php','includes/config.php']) {
    expect(discoverDomains({repo:'besikt',files:{[path]:"<?php const BASE_URL = 'https://besikt.se';"}})[0]).toMatchObject({host:'besikt.se',confidence:'high'});
  }
  expect(discoverDomains({repo:'besikt',files:{'config.php':"<?php $url = 'https://unrelated.test';"}})).toEqual([]);
  expect(discoverDomains({repo:'app.propia',files:{'README.md':'https://propia.com.py https://notpropia.test https://unrelated.test'}})).toEqual([{repo:'app.propia',host:'propia.com.py',source:'README.md matching URL',confidence:'medium'}]);
});
