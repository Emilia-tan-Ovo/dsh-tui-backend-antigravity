import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '@agentclientprotocol/sdk/schema/v1/schema.json' with { type: 'json' };

// The stable SDK deliberately logs and discards invalid notifications. Validate
// its decoded message against its own published schema first, so a detected
// protocol error terminates our pending turn instead of silently hanging it.
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: false });
let validateUpdate: ReturnType<typeof ajv.compile> | undefined;
export function validUpdate(params: unknown): boolean {
  validateUpdate ??= ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: '#/$defs/SessionNotification' });
  return validateUpdate(params) as boolean;
}
