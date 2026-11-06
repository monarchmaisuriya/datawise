// Every value a connection holds as a secret. Errors from drivers can quote connection strings, so
// messages pass through here before they are logged or returned.
const knownSecrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  knownSecrets.add(value);
  knownSecrets.add(encodeURIComponent(value));
}

export function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const secret of knownSecrets) {
    if (secret.length > 0) scrubbed = scrubbed.split(secret).join("[hidden]");
  }
  // The password part of any URL, whether or not it is a known secret.
  return scrubbed.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+(@)/gi, "$1[hidden]$2");
}

export function errorMessage(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    const inner = error.errors.map((item) => errorMessage(item));
    return scrubSecrets([...new Set(inner)].join("; "));
  }
  if (error instanceof Error) return scrubSecrets(error.message || error.name);
  return scrubSecrets(String(error));
}

// Keeps secrets out of what crosses the RPC. The original error stays out of logs for the same reason.
export function guard<Input, Output>(handler: (input: Input) => Promise<Output> | Output): (input: Input) => Promise<Output> {
  return async (input) => {
    try {
      return await handler(input);
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  };
}
