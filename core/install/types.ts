// Install and package shapes shared by the installer, doctor and the packaging scripts.
export interface CopyPlan {
  destination: string;
  files: string[];
}

export interface SettingsWrite {
  path: string;
  content: string;
  before: Buffer | null;
}

export interface LinkPlan {
  path: string;
  target: string;
}

export interface PackageStatus {
  path: string;
  matches: boolean;
  expected: string;
  actual?: string;
  error?: string;
}

export interface InstallOptions {
  repair?: boolean | undefined;
}

export interface InstallationPlan {
  source: string;
  writes: SettingsWrite[];
  copy?: CopyPlan | null | undefined;
  link?: LinkPlan | undefined;
  replace?: boolean | undefined;
}

export interface ProjectInstallPlan {
  root: string;
  writes: SettingsWrite[];
  link: LinkPlan | undefined;
  copy: CopyPlan | undefined;
  drift: PackageStatus | undefined;
  replace: boolean;
}

export interface PackageMetadata {
  name: string;
  version: string;
  files: string[];
  description: string;
}

export interface HarnessSettings {
  permissions?: unknown;
  hooks?: unknown;
  packages?: string[];
  extraKnownMarketplaces?: Record<string, { source: { source: string; path: string } }>;
  enabledPlugins?: Record<string, boolean>;
}

export interface MarketplacePlugin {
  name: string;
  source: { source: string; path: string };
  interface?: { displayName: string; shortDescription: string };
  policy?: { installation: string; authentication: string };
  category?: string;
}

export interface Marketplace {
  name: string;
  plugins: MarketplacePlugin[];
}

export interface PackedArchive {
  filename: string;
  files: { path: string; size: number; mode: number }[];
}
