declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface OpenClawPluginApi {
    registerProvider(provider: unknown): void;
  }

  export function definePluginEntry(entry: {
    register(api: OpenClawPluginApi): void;
  }): unknown;
}
