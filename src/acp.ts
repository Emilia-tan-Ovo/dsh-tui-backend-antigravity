import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { client, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import type { ClientConnection, InitializeResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';
import { deadline, DiagnosticTail, redact, startOwned, type Launch, type OwnedProcess, type ProcessFactory } from './process.js';
import { StringDecoder } from 'node:string_decoder';
import { validUpdate } from './protocol.js';

const { name, version }: { name: string; version: string } = createRequire(import.meta.url)('../package.json');

export interface AcpHandlers {
  update: (params: SessionNotification) => void;
  permission: (params: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>;
  fatal: (error: Error) => void;
  diagnostic?: (text: string) => void;
}

export class Acp {
  readonly connection: ClientConnection;
  readonly process: OwnedProcess;
  readonly died: Promise<never>;
  private diagnosticTail = new DiagnosticTail();
  get stderr(): string { return this.diagnosticTail.text; }
  private stopping = false;
  private disposal?: Promise<void>;
  private fail: (error: Error) => void = () => {};
  initialized?: InitializeResponse;
  constructor(launch: Launch, handlers: AcpHandlers, factory: ProcessFactory = startOwned) {
    this.process = factory(launch);
    this.died = new Promise<never>((_, reject) => { this.fail = reject; });
    this.died.catch(() => {});
    let dead = false;
    const die = (detail: string) => {
      if (dead || this.stopping) return;
      dead = true;
      const error = new Error(`${detail}${this.stderr ? `\n${this.stderr}` : ''}`);
      this.fail(error); handlers.fatal(error);
      void this.dispose();
    };
    const decoder = new StringDecoder('utf8');
    this.process.stderr.on('data', (chunk) => { this.diagnosticTail.append(decoder.write(chunk)); });
    // The SDK frames and validates incoming bytes. Its generated parse-error response
    // is the public-stream signal for malformed input; fail this connection rather
    // than leave a running prompt waiting forever after the SDK discarded that frame.
    const output = new WritableStream<Uint8Array>({
      write: async (bytes) => {
        const generated = JSON.parse(new TextDecoder().decode(bytes));
        if (generated.id === null && [-32700, -32600].includes(generated.error?.code)) {
          die('Antigravity 返回了无效的 ACP 帧；连接已关闭。');
          throw new Error('Invalid ACP frame');
        }
        // Node's generic toWeb adapter may resolve on write acceptance before
        // the native callback reports EPIPE. Cancellation needs that callback.
        await new Promise<void>((resolve, reject) => {
          this.process.stdin.write(bytes, (error) => error ? reject(error) : resolve());
        });
      },
      abort: () => { this.process.stdin.destroy(); },
      close: () => new Promise<void>((resolve) => this.process.stdin.end(resolve)),
    });
    const stream = ndJsonStream(output, Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>);
    const readable = stream.readable.pipeThrough(new TransformStream({
      transform: (message, controller) => {
        if (message.jsonrpc !== '2.0' || ('method' in message && typeof message.method !== 'string') ||
          ('method' in message && message.method === 'session/update' && !validUpdate(message.params))) {
          die('Antigravity 返回了不符合 ACP schema 的通知；连接已关闭。');
          controller.error(new Error('Invalid ACP notification')); return;
        }
        controller.enqueue(message);
      },
    }));
    this.connection = client()
      .onRequest('session/request_permission', ({ params, signal }) => handlers.permission(params, signal))
      .onRequest('*', ({ method }) => { throw new RequestError(-32601, `Unsupported client request: ${method}`); })
      .onNotification('session/update', ({ params }) => handlers.update(params))
      .onNotification('*', ({ method }) => handlers.diagnostic?.(`未支持的 ACP 通知：${method.slice(0, 100)}`))
      .connect({ writable: stream.writable, readable });
    this.connection.closed.then(() => die('Antigravity ACP 连接已断开；已提交输入的结果未知。请重试原会话，未提交输入不会自动重发。'));
    this.process.exited.then((exit) => die(exit.error ? `无法启动 Antigravity：${exit.error.message}` : `Antigravity 进程已退出（${exit.code ?? exit.signal}）。`));
  }
  async initialize(ms: number): Promise<InitializeResponse> {
    return deadline(Promise.race([this.died, (async () => {
      const result = await this.connection.agent.request('initialize', {
        protocolVersion: 1, clientInfo: { name, version },
        clientCapabilities: { session: { notices: {}, compaction: {} } },
      });
      if (result.protocolVersion !== 1) throw new Error(`ACP 版本 ${result.protocolVersion} 不受支持，请更新官方 CLI。`);
      return this.initialized = result;
    })()]), ms, 'Antigravity 初始化');
  }
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.stopping = true;
      this.connection.close();
      await this.process.dispose();
    })();
  }
}

export function actionable(error: unknown, target = '原会话'): string {
  const text = redact(error instanceof Error ? error.message : String(error));
  return /auth|login|sign.?in|credential|unauthori[sz]ed|认证/i.test(text)
    ? `Antigravity 需要认证：请在终端运行 agy，按官方流程登录后重试${target}。\n${text}` : text;
}
