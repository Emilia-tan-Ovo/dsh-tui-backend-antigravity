import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { AgentInput, ContentBlockView, SessionCapabilities } from './host-contract.js';

// Client-side admission bounds, not limits reported by the ACP server. The
// host uses these for its existing in-memory paste/@image store and resampler.
export const IMAGE_LIMITS: NonNullable<SessionCapabilities['images']>['limits'] = Object.freeze({
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  maxImageBytes: 5 * 1024 * 1024, maxImagesPerMessage: 10,
  maxMessageImageBytes: 20 * 1024 * 1024, maxImageDimension: 2048, maxImagePixels: 2048 * 2048,
});

export function inputBlocks(input: AgentInput): ContentBlockView[] {
  const images = input.images ?? [];
  const blocks = input.blocks === undefined
    ? [{ type: 'text', text: input.text }, ...images.map(() => ({ type: 'image' }))]
    : input.blocks.map(b => {
      if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text };
      if (b.type === 'image') return { type: 'image' };
      throw new Error('此版本仅支持文本和图片；附件和整条输入已保留，未发送。');
    });
  if (blocks.filter(b => b.type === 'image').length !== images.length) throw new Error('图片引用与输入块不匹配；整条输入已保留，未发送。');
  return blocks;
}

/** Rewrite only the slash-command prefix; retain interleaved image positions. */
export function routedBlocks(blocks: ContentBlockView[], before: string, after: string): ContentBlockView[] {
  if (before === after) return blocks;
  let remaining = /^\s*\/[^\s]+/.exec(before)![0].length;
  let prefix = /^\s*\/[^\s]+/.exec(after)![0];
  return blocks.map(b => {
    if (b.type !== 'text' || remaining === 0) return b;
    const consumed = Math.min(remaining, b.text!.length); remaining -= consumed;
    const text = prefix + b.text!.slice(consumed); prefix = '';
    return { type: 'text', text };
  });
}

/** Read every facade before sending anything. A missing image refuses the
 * entire message, and cancellation also interrupts an unresponsive reader. */
export async function promptBlocks(blocks: ContentBlockView[], images: NonNullable<AgentInput['images']>, signal: AbortSignal): Promise<ContentBlock[]> {
  if (images.length > IMAGE_LIMITS.maxImagesPerMessage) throw new Error(`每条输入最多 ${IMAGE_LIMITS.maxImagesPerMessage} 张图片。`);
  const converted: ContentBlock[] = [];
  let total = 0;
  for (const image of images) {
    signal.throwIfAborted();
    const mimeType = image.mediaType;
    if (!mimeType || !IMAGE_LIMITS.mediaTypes.includes(mimeType)) throw new Error(`不支持的图片类型：${mimeType ?? '未知'}。`);
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new Error('图片读取已取消')); signal.addEventListener('abort', abort, { once: true }); });
    let data: Uint8Array;
    try { data = await Promise.race([image.read(signal), cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
    signal.throwIfAborted();
    total += data.byteLength;
    if (!data.byteLength || data.byteLength > IMAGE_LIMITS.maxImageBytes || total > IMAGE_LIMITS.maxMessageImageBytes) throw new Error('图片为空或超过图片大小限制。');
    if (image.width > IMAGE_LIMITS.maxImageDimension || image.height > IMAGE_LIMITS.maxImageDimension || image.width * image.height > IMAGE_LIMITS.maxImagePixels) throw new Error('图片尺寸超过限制。');
    converted.push({ type: 'image', mimeType, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') });
  }
  let i = 0;
  return blocks.map(b => b.type === 'image' ? converted[i++] : { type: 'text', text: b.text! });
}
