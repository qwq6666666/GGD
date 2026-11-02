export class SaveError extends Error {
  constructor(
    public readonly code: 'too_large' | 'bad_json' | 'bad_schema' | 'bad_checksum' | 'unknown_version',
    message: string,
  ) {
    super(message);
  }
}
