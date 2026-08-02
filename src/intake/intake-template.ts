/**
 * Single source for the client requirements worksheet.
 *
 * The worksheet used to exist three times over — a hardcoded Markdown string, a static .docx in
 * the frontend's public folder, and the step definitions of the in-system form — and the three
 * had already drifted apart. Everything downloadable is now rendered from the structure below,
 * which deliberately mirrors `ClientIntakePayload` field for field so a client can transcribe a
 * completed worksheet straight into the form.
 *
 * Deliberately non-technical. The client is asked what the software must DO for their business;
 * they are never asked to choose a language, framework, database, or hosting arrangement. Those
 * are decided downstream by the requirements agent from the stack key, and asking a client to
 * pick them produces worse answers than not asking at all.
 */

export interface IntakeTemplateField {
  label: string;
  /** Shown under the label to explain what a good answer looks like. */
  helper: string;
  /** A concrete filled-in answer, so the client is never staring at an empty prompt. */
  example?: string;
  /** True when the client should list several items rather than write one answer. */
  list?: boolean;
}

export interface IntakeTemplateSection {
  /** Matches the step id in the in-system intake form so the two stay aligned. */
  id: 'overview' | 'roles' | 'features' | 'workflows' | 'data' | 'delivery' | 'documents' | 'review';
  title: string;
  purpose: string;
  /** Set when the client should copy the block once per role, feature, or workflow. */
  repeatFor?: string;
  fields: IntakeTemplateField[];
}

export const INTAKE_TEMPLATE_TITLE = 'Project requirements worksheet';

export const INTAKE_TEMPLATE_INTRO = [
  'This worksheet helps you describe what you need built, in your own words. Fill it in with your ' +
    'team, then copy your answers into the project intake in the portal — the portal version is the ' +
    'one your delivery team works from.',
  'You do not need any technical knowledge. Do not choose technologies, programming languages, or ' +
    'hosting; your delivery team decides those. Describe what the software must do for your business ' +
    'and the team will work out how to build it.',
  'Please do not include passwords, API keys, or unnecessary personal data anywhere in this document.',
];

export const INTAKE_TEMPLATE_SECTIONS: IntakeTemplateSection[] = [
  {
    id: 'overview',
    title: '1. What you want to achieve',
    purpose: 'Anchors the business outcome and names who can make final decisions.',
    fields: [
      { label: 'Project name', helper: 'The name your team will recognise.', example: 'Branch appointment booking' },
      {
        label: 'Business goal',
        helper: 'What problem are you solving, and what changes when this succeeds? Describe the outcome, not the screens.',
        example: 'Customers currently book by phone, which ties up two staff all morning. We want customers to book themselves online.',
      },
      {
        label: 'How you will measure success',
        helper: 'One measure per line. Make each one countable by a person, a date, or a number.',
        example: 'Cut phone bookings by 40% within three months of launch.',
        list: true,
      },
      { label: 'Main contact', helper: 'Who the delivery team should ask when something is unclear.' },
      { label: 'Final approver', helper: 'Who can accept scope decisions on your behalf.' },
      { label: 'Preferred launch period', helper: 'A month, quarter, or fixed date is fine.', example: 'October 2026' },
    ],
  },
  {
    id: 'roles',
    title: '2. Who will use it',
    purpose: 'Knowing who does what prevents access that is too broad or too restrictive.',
    repeatFor: 'each type of user',
    fields: [
      { label: 'Role name', helper: 'Name a real group of people, not a feature.', example: 'Branch scheduler' },
      { label: 'What they do', helper: 'One responsibility per line.', example: 'Creates and reschedules appointments.', list: true },
      {
        label: 'What they are allowed to see or change',
        helper: 'One rule per line. Be specific about limits.',
        example: 'Can edit appointments only for their own branch.',
        list: true,
      },
    ],
  },
  {
    id: 'features',
    title: '3. What it needs to do',
    purpose: 'A focused, checkable list is what lets your PM agree a scope that can actually be built and verified.',
    repeatFor: 'each thing the system must do',
    fields: [
      { label: 'Feature name', helper: 'Short and plain.', example: 'Customer self-service booking' },
      { label: 'Why it matters', helper: 'Tie it to a person or a business outcome.', example: 'Lets customers book outside office hours without calling.' },
      { label: 'Who uses it', helper: 'Pick one of the roles you named in section 2.' },
      {
        label: 'How important is it',
        helper: 'Must-have (the first release fails without it), Should-have (important, could follow shortly), or Nice-to-have (only if there is room).',
        example: 'Must-have',
      },
      { label: 'What happens when someone uses it', helper: 'Describe it as a short story from start to finish.' },
      {
        label: 'Rules that must always hold',
        helper: 'One rule per line. Write "None" if nothing special applies.',
        example: 'Two appointments can never be booked in the same slot.',
        list: true,
      },
      {
        label: 'How you will know it works',
        helper: 'One check per line, each something a person could sit down and verify.',
        example: 'Booking a taken slot shows alternatives and does not create a booking.',
        list: true,
      },
    ],
  },
  {
    id: 'workflows',
    title: '4. How the work flows',
    purpose: 'Steps, decisions, and failures tell the team how things should behave in real situations, not just the happy path.',
    repeatFor: 'each process worth walking through',
    fields: [
      { label: 'Process name', helper: 'What this walkthrough covers.', example: 'Rescheduling an appointment' },
      { label: 'What starts it', helper: 'What must be true before this begins?' },
      { label: 'Who is doing it', helper: 'One of your roles from section 2.' },
      { label: 'The steps', helper: 'One step per line, in order.', list: true },
      { label: 'Points where someone must choose or approve', helper: 'One per line. Write "None" if there are none.', list: true },
      {
        label: 'What can go wrong, and what should happen then',
        helper: 'One per line. This is the part most often missed.',
        example: 'Customer arrives at a cancelled slot — send a text the moment it is cancelled.',
        list: true,
      },
      { label: 'How it ends', helper: 'What is true once this finishes successfully?' },
    ],
  },
  {
    id: 'data',
    title: '5. Information you keep track of',
    purpose: 'Knowing what is recorded, and who may see it, keeps privacy and access visible from the start.',
    fields: [
      {
        label: 'Things you need to record',
        helper: 'One per line, in business terms. For each, note the details that matter and who may see or change it.',
        example: 'Appointment — customer name, service, date and time. Staff see only their own branch.',
        list: true,
      },
      {
        label: 'Other systems this must work with',
        helper: 'One per line. Name the service, what is exchanged, and who at your company owns it. Write "None" if there are none.',
        example: 'Payment provider — takes deposits at booking. Owned by Finance.',
        list: true,
      },
    ],
  },
  {
    id: 'delivery',
    title: '6. Look, feel, and practical constraints',
    purpose: 'These shape the right experience and make the delivery plan realistic.',
    fields: [
      {
        label: 'Look, feel, and branding',
        helper: 'Brand colours and logos, which devices people will use, and any accessibility expectations.',
        example: 'Must match our brand guide, work well on phones, and be usable with a screen reader.',
      },
      {
        label: 'Privacy, safety, and reliability expectations',
        helper: 'One per line. Describe expectations, never actual credentials.',
        example: 'Customer phone numbers must not be visible to staff at other branches.',
        list: true,
      },
      { label: 'Things you must provide or approve', helper: 'One per line — content, sign-offs, or access your team owes the project.', list: true },
      { label: 'Dates that matter', helper: 'One per line, including anything you are committed to externally.', list: true },
      {
        label: 'Explicitly NOT in this release',
        helper: 'One per line. Naming exclusions protects you as much as the team.',
        example: 'No mobile app — web only for this release.',
        list: true,
      },
      { label: 'Wanted later, but must not delay this release', helper: 'One per line.', list: true },
    ],
  },
  {
    id: 'documents',
    title: '7. Supporting documents',
    purpose:
      'Documents give the delivery team evidence instead of guesswork. Anything you attach is read by the team and by the automated build agents.',
    fields: [
      {
        label: 'Documents you can share',
        helper:
          'One per line. Useful examples: a current process map, an example of a form you use today, ' +
          'your brand guide, a price list, or requirements you have written before. Upload these in the ' +
          'portal — this list is just to plan what you will send.',
        list: true,
      },
      {
        label: 'If you have no documents',
        helper: 'Say so explicitly in the portal by ticking "No supporting documents apply". The team then knows nothing is missing.',
      },
    ],
  },
  {
    id: 'review',
    title: '8. Before you send it',
    purpose: 'A last check that your PM receives something complete enough to agree and act on.',
    fields: [
      { label: 'Every must-have has a way to check it works', helper: 'Look back at section 3.' },
      { label: 'Every process has an ending and its likely failures', helper: 'Look back at section 4.' },
      { label: 'You have named what is NOT included', helper: 'Look back at section 6.' },
      { label: 'No passwords, keys, or unnecessary personal data anywhere', helper: 'Check every section and every attachment.' },
    ],
  },
];

function renderFieldMarkdown(field: IntakeTemplateField): string {
  const lines = [`**${field.label}**`, `_${field.helper}_`];
  if (field.example) lines.push(`_Example: ${field.example}_`);
  lines.push('', field.list ? '- \n- \n- ' : '> ');
  return lines.join('\n');
}

export function renderIntakeTemplateMarkdown(): string {
  const intro = INTAKE_TEMPLATE_INTRO.map((line) => `${line}\n`).join('\n');
  const sections = INTAKE_TEMPLATE_SECTIONS.map((section) => {
    const heading = [`## ${section.title}`, '', `_${section.purpose}_`];
    if (section.repeatFor) heading.push('', `_Copy this block once for ${section.repeatFor}._`);
    return [...heading, '', section.fields.map(renderFieldMarkdown).join('\n\n')].join('\n');
  }).join('\n\n---\n\n');

  return `# ${INTAKE_TEMPLATE_TITLE}\n\n${intro}\n---\n\n${sections}\n`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function renderFieldHtml(field: IntakeTemplateField): string {
  const example = field.example ? `<p class="example">Example: ${escapeHtml(field.example)}</p>` : '';
  // Ruled write-in space rather than a form input: this is printed, or opened in a word
  // processor and typed into, not submitted from the browser.
  const answer = field.list
    ? '<ul class="answer"><li></li><li></li><li></li></ul>'
    : '<div class="answer"></div>';
  return `<div class="field"><h4>${escapeHtml(field.label)}</h4><p class="helper">${escapeHtml(field.helper)}</p>${example}${answer}</div>`;
}

/**
 * A printable worksheet built from the same structure as the Markdown.
 *
 * HTML rather than DOCX on purpose: Word and Google Docs both open and edit it directly, any
 * browser prints it to PDF, and it needs no document-generation dependency — so it can never
 * fall out of step with the form the way the checked-in binary template did.
 */
export function renderIntakeTemplateHtml(): string {
  const intro = INTAKE_TEMPLATE_INTRO.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
  const sections = INTAKE_TEMPLATE_SECTIONS.map((section) => {
    const repeat = section.repeatFor
      ? `<p class="repeat">Copy this block once for ${escapeHtml(section.repeatFor)}.</p>`
      : '';
    return `<section><h2>${escapeHtml(section.title)}</h2><p class="purpose">${escapeHtml(section.purpose)}</p>${repeat}${section.fields.map(renderFieldHtml).join('')}</section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(INTAKE_TEMPLATE_TITLE)}</title>
<style>
  body { font-family: Calibri, Arial, sans-serif; color: #111; line-height: 1.5; max-width: 46em; margin: 2em auto; padding: 0 1.5em; }
  h1 { font-size: 1.9em; margin-bottom: .4em; }
  h2 { font-size: 1.25em; margin-top: 1.8em; border-bottom: 2px solid #111; padding-bottom: .25em; }
  h4 { font-size: 1em; margin: 1.3em 0 .2em; }
  .purpose, .helper, .example, .repeat { color: #555; font-size: .9em; margin: .2em 0; }
  .example, .repeat { font-style: italic; }
  .intro { background: #f4f6fa; border-left: 4px solid #2f6bff; padding: .9em 1.1em; margin-bottom: 2em; }
  .intro p { margin: .5em 0; }
  .answer { border-bottom: 1px solid #bbb; min-height: 2.6em; margin-top: .5em; }
  ul.answer { border: 0; list-style: none; padding: 0; }
  ul.answer li { border-bottom: 1px solid #bbb; min-height: 1.7em; margin-bottom: .5em; }
  section { page-break-inside: avoid; }
  @media print { body { margin: 0; max-width: none; } }
</style>
</head>
<body>
<h1>${escapeHtml(INTAKE_TEMPLATE_TITLE)}</h1>
<div class="intro">${intro}</div>
${sections}
</body>
</html>
`;
}
