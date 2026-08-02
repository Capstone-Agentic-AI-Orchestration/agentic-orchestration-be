import { describe, expect, it } from 'vitest';
import {
  INTAKE_TEMPLATE_SECTIONS,
  renderIntakeTemplateHtml,
  renderIntakeTemplateMarkdown,
} from './intake-template';
import { emptyClientIntakePayload } from './intake.types';

/**
 * Terms a client should never be asked about. The worksheet captures what the business needs the
 * software to do; the stack is chosen downstream by the requirements agent.
 */
const TECHNICAL_TERMS =
  /\b(react|next\.?js|nest(js)?|postgres(ql)?|supabase|tailwind|typescript|javascript|docker|kubernetes|api endpoint|database schema|tech stack|framework|repository|microservice)\b/i;

describe('intake worksheet template', () => {
  it('covers every step of the in-system intake form', () => {
    // The worksheet is only useful as a companion if a client can transcribe it straight into the
    // form, so the section list must track the form's steps exactly.
    expect(INTAKE_TEMPLATE_SECTIONS.map((section) => section.id)).toEqual([
      'overview',
      'roles',
      'features',
      'workflows',
      'data',
      'delivery',
      'documents',
      'review',
    ]);
  });

  it('mirrors the payload the form collects', () => {
    const payload = emptyClientIntakePayload({ projectName: 'X', companyName: 'X', brief: '' });
    const sectionIds = new Set(INTAKE_TEMPLATE_SECTIONS.map((section) => section.id));

    // Each top-level payload group needs somewhere on the worksheet to come from.
    expect(sectionIds.has('overview')).toBe(true);
    expect(Object.keys(payload)).toEqual([
      'overview',
      'roles',
      'features',
      'workflows',
      'dataAndIntegrations',
      'experienceAndDelivery',
    ]);
    expect(sectionIds.has('data')).toBe(true);
    expect(sectionIds.has('delivery')).toBe(true);
  });

  it('never asks the client to make technical choices', () => {
    const markdown = renderIntakeTemplateMarkdown();
    const match = TECHNICAL_TERMS.exec(markdown);

    expect(match?.[0] ?? null).toBeNull();
  });

  it('renders every section and field into the markdown worksheet', () => {
    const markdown = renderIntakeTemplateMarkdown();

    for (const section of INTAKE_TEMPLATE_SECTIONS) {
      expect(markdown).toContain(section.title);
      for (const field of section.fields) expect(markdown).toContain(field.label);
    }
  });

  it('renders a self-contained printable worksheet', () => {
    const html = renderIntakeTemplateHtml();

    expect(html.startsWith('<!doctype html>')).toBe(true);
    for (const section of INTAKE_TEMPLATE_SECTIONS) expect(html).toContain(section.title);
    // Styles are inlined so the file opens correctly in Word with no external requests.
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/<script/i);
  });

  it('escapes field text rather than injecting it raw into the printable worksheet', () => {
    const html = renderIntakeTemplateHtml();

    // Several helpers quote the word "None"; those quotes must arrive as entities, which proves
    // escaping runs over field content and not just over the surrounding markup.
    expect(html).toContain('&quot;None&quot;');
    // The raw quote character must not survive anywhere inside rendered field copy.
    expect(html).not.toContain('"None"');
  });
});
