import { describe, expect, it } from 'vitest';
import { describeEvidenceGap } from './orchestration.service';
import type { IntakeContextPackage, RequirementEvidence } from '../intake/intake.types';

function source(documentId: string) {
  return {
    documentId,
    documentVersion: 1,
    title: `${documentId}.pdf`,
    kind: 'REQUIREMENT',
    sha256: 'abc',
    extractedText: 'Some readable requirement text.',
  };
}

function context(documentIds: string[]): IntakeContextPackage {
  return {
    schemaVersion: 'intake-context-v1',
    projectId: 'project-1',
    intakeSnapshotId: 'snapshot-1',
    intakeVersion: 1,
    canonicalBrief: 'Build a booking portal.',
    clientRequirements: {} as IntakeContextPackage['clientRequirements'],
    pmNotes: '',
    sources: documentIds.map(source),
  };
}

function evidence(documentIds: string[]): RequirementEvidence[] {
  return documentIds.map((documentId) => ({ documentId, supports: 'Booking flow' }));
}

describe('describeEvidenceGap', () => {
  it('allows a project that supplied no documents', () => {
    // The intake has an explicit "no supporting documents apply" path; blocking here would make
    // every document-less project permanently un-approvable.
    expect(describeEvidenceGap({ intakeContext: context([]), requirementsEvidence: [] })).toBeNull();
  });

  it('allows a gate when at least one supplied document is cited', () => {
    expect(
      describeEvidenceGap({ intakeContext: context(['doc-1', 'doc-2']), requirementsEvidence: evidence(['doc-1']) }),
    ).toBeNull();
  });

  it('blocks when documents were supplied but nothing was cited', () => {
    const gap = describeEvidenceGap({
      intakeContext: context(['doc-1', 'doc-2']),
      requirementsEvidence: [],
    });

    expect(gap).toContain('supplied 2 source documents');
    expect(gap).toContain('cite none of them');
  });

  it('blocks when every citation points outside the supplied documents', () => {
    const gap = describeEvidenceGap({
      intakeContext: context(['doc-1']),
      requirementsEvidence: evidence(['hallucinated-doc']),
    });

    expect(gap).toBe(
      'The parsed requirements cite no supplied document. Re-run requirements parsing before approving.',
    );
  });

  it('treats missing state as nothing to verify', () => {
    expect(describeEvidenceGap(null)).toBeNull();
    expect(describeEvidenceGap({})).toBeNull();
  });
});
