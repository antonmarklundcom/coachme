import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // lib/runbook.ts reads templates/*.md by a dynamically-picked filename
  // (templateFor(dialect)), so Next's static import tracing can't discover
  // them on its own — without this, the runbook renders locally (where the
  // repo checkout is on disk) but 500s on Vercel, where only traced files
  // ship in the serverless bundle.
  outputFileTracingIncludes: {
    "/": ["./templates/*.md"],
  },
};

export default nextConfig;
