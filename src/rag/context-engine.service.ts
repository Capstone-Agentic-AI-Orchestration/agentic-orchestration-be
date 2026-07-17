import { Injectable } from '@nestjs/common';
import { formatRagContextPackForPrompt, RagContextPackBuilderService } from './rag-context-pack-builder.service';
import { RagContextPack, RagRetrieveInput } from './rag.types';

/** Stable orchestration-facing facade for the Iris-like context engine. */
@Injectable()
export class ContextEngineService {
  constructor(private readonly builder: RagContextPackBuilderService) {}

  buildContextPack(input: RagRetrieveInput): Promise<RagContextPack> {
    return this.builder.build(input);
  }

  async buildPromptContext(input: RagRetrieveInput): Promise<{ pack: RagContextPack; prompt: string }> {
    const pack = await this.buildContextPack(input);
    return { pack, prompt: formatRagContextPackForPrompt(pack) };
  }

  async buildPromptContextSafe(input: RagRetrieveInput): Promise<string> {
    try {
      return (await this.buildPromptContext(input)).prompt;
    } catch {
      // RAG is additive: a transient index/provider outage must not stop an
      // orchestration run because keyword/layered memory remains available.
      return '';
    }
  }
}
