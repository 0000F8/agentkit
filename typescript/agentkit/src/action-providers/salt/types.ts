/**
 * Configuration for SaltActionProvider.
 */
export interface SaltActionProviderConfig {
  /** Salt API base URL, e.g. "https://saltapp.ai" (no trailing slash). Defaults to the SALT_HOST env var. */
  host?: string;
  /** This agent's own Salt user id. Required for salt_pay_request, which refuses to pay a request not addressed to this exact id. Defaults to the SALT_AGENT_ID env var. */
  agentId?: string;
  /** This agent's Salt api-key. Defaults to the SALT_API_KEY env var. */
  apiKey?: string;
  /**
   * Armored PGP private key + the passphrase protecting it. Optional --
   * without it this provider is "keyless": it can still send messages
   * (encryption needs only recipients' public keys) and still see button
   * taps on salt_ask_human cards (Salt reports those in plaintext
   * metadata), but cannot decrypt a free-text reply typed instead of
   * tapping a button. Defaults to SALT_PGP_PRIVATE_KEY / SALT_PGP_PASSPHRASE.
   */
  pgpPrivateKey?: string;
  pgpPassphrase?: string;
}

export interface ResolvedSaltConfig {
  host: string;
  agentId: string;
  apiKey: string;
  pgpPrivateKey?: string;
  pgpPassphrase?: string;
}

/**
 * Builds the provider configuration from the given values and SALT_* environment variables.
 *
 * @param config - The provider configuration.
 *
 * @returns The resolved configuration.
 */
export function resolveSaltConfig(config: SaltActionProviderConfig = {}): ResolvedSaltConfig {
  const host = (config.host ?? process.env.SALT_HOST ?? "").replace(/\/$/, "");
  const agentId = config.agentId ?? process.env.SALT_AGENT_ID ?? "";
  const apiKey = config.apiKey ?? process.env.SALT_API_KEY ?? "";
  const missing: string[] = [];
  if (!host) missing.push("host (SALT_HOST)");
  if (!agentId) missing.push("agentId (SALT_AGENT_ID)");
  if (!apiKey) missing.push("apiKey (SALT_API_KEY)");
  if (missing.length > 0) {
    throw new Error(`saltActionProvider is missing required configuration: ${missing.join(", ")}`);
  }
  const pgpPrivateKey = config.pgpPrivateKey ?? process.env.SALT_PGP_PRIVATE_KEY ?? undefined;
  const pgpPassphrase = config.pgpPassphrase ?? process.env.SALT_PGP_PASSPHRASE ?? undefined;
  return {
    host,
    agentId,
    apiKey,
    pgpPrivateKey: pgpPrivateKey || undefined,
    pgpPassphrase: pgpPassphrase || undefined,
  };
}
