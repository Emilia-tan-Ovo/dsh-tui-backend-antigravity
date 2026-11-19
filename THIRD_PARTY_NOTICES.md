# Third-party notices

## dsh-agy-acp (MIT)

Protocol lifecycle and permission-description work was informed by
[alfiwillianz/dsh-agy-acp](https://github.com/alfiwillianz/dsh-agy-acp/tree/ee5ae39f733aefc4b88924d672661e31818a7081),
snapshot `ee5ae39f733aefc4b88924d672661e31818a7081` (`src/acp-process.ts`, `src/permission.ts`, fake-agent testing).
This implementation replaces pooling, replay, cancellation and permission mapping
with a session-owned host adapter and Windows Job ownership. The full MIT notice
is retained in `licenses/dsh-agy-acp-MIT.txt`.

## Agent Client Protocol TypeScript SDK (Apache-2.0)

Runtime dependency `@agentclientprotocol/sdk` 2.7.0 handles ACP framing and RPC.
Its license is reproduced in `licenses/agentclientprotocol-Apache-2.0.txt`;
the dependency's own distribution retains its attribution.

## Zod (MIT)

Runtime dependency `zod` 3.25.76 supplies the SDK's schema peer. Its MIT license
is reproduced in `licenses/zod-MIT.txt`.

The Hermes backend was studied for host structure only; its source is not included.

## Ajv (MIT)

`ajv` 8.17.1 validates decoded session notifications against the stable SDK's
published JSON schema before dispatch. This lets protocol errors end pending
turns instead of being logged and discarded by the SDK. Its MIT notice is in
`licenses/ajv-MIT.txt`; transitive dependencies retain their own distribution notices.
