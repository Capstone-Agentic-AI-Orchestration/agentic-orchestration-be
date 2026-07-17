import { Injectable } from '@nestjs/common';
import { compactText } from './rag-safety';
import { CompressedContext, RetrievedContextItem } from './rag.types';

@Injectable()
export class ContextCompressorService {
  compress(items: RetrievedContextItem[], maxChars = 12_000): CompressedContext {
    const warnings: string[] = [];
    const accepted: RetrievedContextItem[] = [];
    const seen = new Set<string>();
    let usedChars = 0;

    for (const item of items) {
      const key = compactText(item.summary ?? item.content, 240).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const priority = ['project', 'work_order', 'architecture_decision', 'error', 'fix', 'handoff'].includes(item.sourceType);
      const available = maxChars - usedChars;
      if (available < 180 && !priority) continue;
      if (available <= 0) break;

      const content = compactText(item.content, Math.min(priority ? 1_400 : 900, Math.max(180, available)));
      if (!content) continue;
      accepted.push({ ...item, content, summary: item.summary ? compactText(item.summary, 500) : undefined });
      usedChars += content.length;
    }

    if (accepted.length < items.length) warnings.push('Context was compressed to fit the configured budget.');
    if (!accepted.length && items.length) warnings.push('No retrieved chunks fit the configured context budget.');
    return { items: accepted, usedChars, warnings };
  }
}
