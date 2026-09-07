/** Public configuration accepted by the installed GatherThread DSH bundle. */
export interface GatherThreadDshPluginConfig {
  /** The package layer is opt-in and inert unless explicitly enabled. */
  readonly enabled?: boolean;
  /** Deprecated compatibility hint; native pairing now uses managed GatherThread Project workspaces. */
  readonly workspacePath?: string;
  /** Optional test or advanced-profile home. Normal npm users omit this. */
  readonly dshHome?: string;
  /** Optional public GatherThread service shown as the first connection choice. */
  readonly officialServerUrl?: string;
}

export declare const name: "gatherthread-dsh-native";
export declare const inject: readonly [
  "agents",
  "sessions",
  "sessionPersistence",
  "sessionQuery",
  "sessionTitle",
  "workspaceRegistry",
  "llm",
  "credentials",
  "connection",
];

/** Cordis Host entry loaded by the package's official DSH profile layer. */
export declare function apply(
  context: unknown,
  config?: GatherThreadDshPluginConfig,
): Promise<void>;
