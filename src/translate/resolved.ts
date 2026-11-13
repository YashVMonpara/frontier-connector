/**
 * Resolved-image plumbing for the wire translators. ImageBlocks may carry inline
 * base64 data, a data: URL, or an external attachment reference resolved via an
 * optional AttachmentStore. Adapters resolve images BEFORE calling the (pure,
 * synchronous) translators, so translators see {@link ResolvedImagePart}s with
 * inline base64 data.
 */

import { LlmError } from '../types.js'
import type { AttachmentStore, ContentBlock, Message, ToolResultBlock } from '../types.js'

/** An image block with its bytes resolved to inline base64 for the wire. */
export interface ResolvedImagePart {
  type: 'image'
  /** MIME type of the image (e.g. `image/png`). */
  mediaType: string
  /** Base64-encoded image bytes. */
  dataBase64: string
}

/** Translator input block: a message block with images pre-resolved. */
export type TranslatableBlock = Exclude<ContentBlock, ToolResultBlock> | ResolvedImagePart | ResolvedToolResultBlock

/** Tool results may themselves carry images. */
export interface ResolvedToolResultBlock extends Omit<ToolResultBlock, 'content'> {
  content: readonly TranslatableBlock[]
}

/**
 * Wires with text-only tool outputs receive images in a following user turn.
 * Defer that turn until all consecutive user messages have been processed:
 * parallel tool results can arrive in separate messages, and a user image
 * message must not interrupt their tool-call/output pairing.
 */
export function withToolResultImages(messages: readonly TranslatableMessage[]): TranslatableMessage[] {
  const out: TranslatableMessage[] = []
  let images: TranslatableBlock[] = []
  const flush = (): void => {
    if (images.length > 0) out.push({ role: 'user', content: images })
    images = []
  }
  for (const message of messages) {
    if (message.role === 'assistant') flush()
    out.push(message)
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      const parts = block.content.filter((part): part is ResolvedImagePart => part.type === 'image' && 'dataBase64' in part)
      if (parts.length > 0) {
        images.push({ type: 'text', text: `Images from tool result ${String(block.toolCallId)}:` }, ...parts)
      }
    }
  }
  flush()
  return out
}

/** Translator input message: role plus resolved blocks. */
export interface TranslatableMessage {
  role: 'system' | 'user' | 'assistant'
  content: readonly TranslatableBlock[]
}

function parseDataUrl(url: string): { mediaType: string; dataBase64: string } | undefined {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url.trim())
  if (!match) return undefined
  return { mediaType: match[1].toLowerCase(), dataBase64: match[2].replace(/\s+/g, '') }
}

/**
 * Resolve every ImageBlock into inline base64 bytes.
 * Inline base64 blocks and `data:...;base64,...` URLs resolve directly with no
 * external store. Attachment-referenced images use `attachments.readImage()` and
 * fail loudly if no attachment store is configured.
 */
export async function resolveImages(
  messages: readonly Message[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly TranslatableMessage[]> {
  const needsResolution = (block: ContentBlock): boolean => block.type === 'image'
    || (block.type === 'tool-result' && block.content.some(needsResolution))
  if (!messages.some(message => message.content.some(needsResolution))) {
    return messages
  }
  const resolveBlock = async (block: ContentBlock): Promise<TranslatableBlock[]> => {
    if (block.type === 'tool-result') {
      return [{ ...block, content: (await Promise.all(block.content.map(resolveBlock))).flat() }]
    }
    if (block.type !== 'image') return [block]
    if ('dataBase64' in block && typeof block.dataBase64 === 'string' && typeof block.mediaType === 'string') {
      return [{ type: 'image', mediaType: block.mediaType, dataBase64: block.dataBase64 }]
    }
    if ('url' in block && typeof block.url === 'string') {
      const parsed = parseDataUrl(block.url)
      if (!parsed) {
        throw new LlmError('frontier-connector: image URLs must be base64 data URLs or inline base64 images.', 'UNSUPPORTED')
      }
      return [{ type: 'image', mediaType: block.mediaType ?? parsed.mediaType, dataBase64: parsed.dataBase64 }]
    }
    if (!('attachment' in block) || !block.attachment) {
      throw new LlmError('frontier-connector: image block is missing inline data and attachment reference.', 'INVALID_REQUEST')
    }
    if (attachments === undefined) {
      throw new LlmError(
        'frontier-connector: the request carries an attachment image but no attachment resolver is configured; '
        + 'pass inline base64 images or configure resolveAttachments',
        'UNSUPPORTED',
      )
    }
    const stored = await attachments.readImage(block.attachment, signal)
    const { attachmentId, mediaType, bytes, width, height, name } = stored.ref
    return [{
      type: 'image',
      mediaType: stored.ref.mediaType,
      dataBase64: Buffer.from(stored.data).toString('base64'),
    }, {
      type: 'text',
      text: `Image reference (for image_generate.referenceImages): ${JSON.stringify({
        attachmentId, mediaType, bytes, width, height, ...name === undefined ? {} : { name },
      })}`,
    }]
  }
  return Promise.all(messages.map(async (message): Promise<TranslatableMessage> => ({
    role: message.role,
    content: (await Promise.all(message.content.map(resolveBlock))).flat(),
  })))
}
