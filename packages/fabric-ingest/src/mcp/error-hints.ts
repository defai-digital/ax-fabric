/**
 * Error message enrichment with remediation hints for MCP tool handlers.
 *
 * Maps common error patterns to actionable hints that help AI agents
 * and users recover from failures without external documentation.
 */

export function getErrorHint(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes("not found") && lower.includes("collection")) {
    return "\n\nDid you create the collection first? Use akidb_create_collection.";
  }

  if (lower.includes("dimension") && lower.includes("mismatch")) {
    return (
      "\n\nThe query vector dimension must match the collection dimension. "
      + "Check the collection with akidb_collection_status."
    );
  }

  if (lower.includes("no manifest") || lower.includes("manifest not found")) {
    return (
      "\n\nNo data has been published yet. After upserting records, "
      + "call akidb_publish to make them searchable."
    );
  }

  if (lower.includes("embedder") || lower.includes("cloudflare") || lower.includes("api_key")) {
    return (
      "\n\nThe embedder is not configured or the API key is missing. "
      + "Check fabric_config_show and set the api_key_env in your environment."
    );
  }

  if (lower.includes("no extractor") || lower.includes("unsupported file")) {
    return (
      "\n\nThis file type is not supported for extraction. "
      + "Check axfabric://formats for supported file types."
    );
  }

  if (lower.includes("enoent") || lower.includes("no such file")) {
    return "\n\nThe specified file or directory does not exist. Check the path and try again.";
  }

  if (lower.includes("already exists")) {
    return (
      "\n\nA collection with that ID already exists. "
      + "Use akidb_list_collections to see existing collections."
    );
  }

  if (lower.includes("deleted")) {
    return (
      "\n\nThis collection has been soft-deleted. "
      + "Create a new collection with akidb_create_collection."
    );
  }

  return "";
}

/** Format an error response with optional remediation hint. */
export function formatError(e: unknown): { isError: true; content: Array<{ type: "text"; text: string }> } {
  const msg = (e as Error).message ?? String(e);
  const hint = getErrorHint(msg);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${msg}${hint}` }],
  };
}
