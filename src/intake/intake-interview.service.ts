import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InquiryStatus, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { AgentLlmRouter } from '../orchestration/providers/agent-llm.router';
import { PrismaService } from '../prisma/prisma.service';
import { IntakeService } from './intake.service';
import { emptyClientIntakePayload } from './intake.types';
import type {
  ClientIntakePayload,
  IntakeInterviewTopicId,
  IntakeInterviewTurn,
} from './intake.types';

/**
 * The agenda. Four topics, in this order, and nothing else is ever asked.
 *
 * A fixed list rather than a model deciding what to ask next, because an interview that invents its
 * own questions cannot be tested, cannot be predicted by the person answering, and drifts toward
 * asking for whatever the payload happens to be missing — which is how the eight-step form got its
 * decision points and error cases. What the model does here is phrase and absorb. What it asks is
 * this list.
 *
 * Everything absent from this list is deliberate: acceptance criteria, business rules, decision
 * points, error cases, permissions and data entities are analyst work. A client cannot write them
 * and should not be asked to. They are derived and marked as assumed.
 */
const TOPICS: Array<{
  id: IntakeInterviewTopicId;
  /** Answered means "we have enough of this to move on" — not "this section is full". */
  answered: (payload: ClientIntakePayload) => boolean;
  /** Asked when nothing is known yet. */
  opening: string;
  /** A concrete answer, so the client can see the shape of a useful reply. */
  example: string;
  /** The payload keys this topic is allowed to write. Scoping the merge is what keeps one answer
   *  from quietly rewriting another topic's fields. */
  fields: string;
}> = [
  {
    id: 'goal',
    answered: (payload) =>
      Boolean(payload.overview.businessGoal.trim()) &&
      payload.overview.successMeasures.some((measure) => measure.trim()),
    opening: 'What should this software do for your business, and how will you know it worked?',
    example: 'Cut phone bookings for depot slots. We would call it a success if 80% of slots are booked online by October.',
    fields: '"businessGoal": string, "successMeasures": string[]',
  },
  {
    id: 'users',
    answered: (payload) => payload.roles.some((role) => role.name.trim() && role.responsibilities.length > 0),
    opening: 'Who will use it, and what does each of them do with it?',
    example: 'Dispatchers book and reschedule slots. Drivers confirm arrival. Depot managers see the day ahead.',
    fields: '"roles": [{ "name": string, "responsibilities": string[] }]',
  },
  {
    id: 'musthaves',
    answered: (payload) =>
      payload.features.some(
        (feature) => feature.priority === 'MUST_HAVE' && feature.title.trim() && feature.purpose.trim(),
      ),
    opening: 'What must it be able to do on day one? List the things it would be useless without.',
    example: 'Book a slot. See what is already booked. Cancel a booking and free the slot up again.',
    fields: '"features": [{ "title": string, "purpose": string, "primaryRole": string, "priority": "MUST_HAVE" | "SHOULD_HAVE" | "NICE_TO_HAVE" }]',
  },
  {
    id: 'boundaries',
    // Any one of these counts. They are asked together and clients rarely answer all four, so
    // demanding the set would stall the interview on its last question.
    answered: (payload) =>
      payload.experienceAndDelivery.outOfScope.length > 0 ||
      payload.dataAndIntegrations.integrations.length > 0 ||
      Boolean(payload.overview.targetLaunch.trim()) ||
      Boolean(payload.overview.approver.trim()),
    opening: 'Last one. Anything it must connect to, anything deliberately not included, when you need it, and who signs off?',
    example: 'It has to work with our Stripe account. Driver payroll is out of scope. Needed by October. Priya approves.',
    fields: '"outOfScope": string[], "integrations": [{ "name": string, "purpose": string, "owner": string }], "targetLaunch": string, "approver": string',
  },
];

const SYSTEM_PROMPT = `You are interviewing a client about software they want built. You are warm, brief, and you never sound like a form.

Rules:
- Ask about ONE topic per turn. You are given the topic; do not go off it and do not ask ahead.
- Never invent an answer. If a reply is vague, extract only what was actually said and leave the rest empty.
- Use the client's own words. Do not translate "booking" into "reservation entity".
- Never ask about acceptance criteria, business rules, decision points, error cases, permissions or
  data models. Those are not the client's job and asking makes them feel tested.
- Two or three sentences maximum. No preamble, no numbered lists, no restating what they just said.`;

/**
 * What the interview is filling in.
 *
 * Two things hold a brief in the same shape: a project's intake, and a lead that has not been
 * approved yet. The agenda, the prompts and the merge rules do not care which — only loading and
 * saving differ — so those two operations are all this interface carries.
 *
 * The alternative was a `projectId | inquiryId` parameter threaded through every method, which
 * would have put "which kind is this?" branching inside the conversation logic that has nothing to
 * do with either.
 */
export interface InterviewSubject {
  load(): Promise<ClientIntakePayload>;
  save(payload: ClientIntakePayload): Promise<void>;
  /** Correlates model calls for cost tracking. Absent on a lead, which has no project yet. */
  projectId?: string;
}

/**
 * Runs the client through the agenda, one topic per turn.
 *
 * The interview does not replace the intake — it fills the same `ClientIntakePayload` the form
 * always filled, so the project manager's review, the readiness rules and the locked context package
 * are untouched. Only the way the answers arrive has changed.
 *
 * The transcript is deliberately not persisted. What matters is the brief, which autosaves through
 * the existing draft route; the conversation is how it got there, not a record anyone needs.
 */
@Injectable()
export class IntakeInterviewService {
  private readonly logger = new Logger(IntakeInterviewService.name);

  constructor(
    private readonly intake: IntakeService,
    private readonly llm: AgentLlmRouter,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Advances the interview by one turn.
   *
   * @param reply What the client just said. Omitted on the opening turn.
   * @param topicId Which topic the reply answers. Ignored without a reply; required with one, so a
   *   late-arriving answer cannot be absorbed into whatever topic happens to be current now.
   */
  async takeTurn(
    subject: InterviewSubject,
    input: { reply?: string; topicId?: IntakeInterviewTopicId } = {},
  ): Promise<IntakeInterviewTurn> {
    let payload = await subject.load();
    const projectId = subject.projectId;

    const reply = input.reply?.trim();
    if (reply) {
      const topic = TOPICS.find((candidate) => candidate.id === input.topicId);
      if (!topic) throw new BadRequestException('Unknown interview topic');
      payload = await this.absorb(payload, topic, reply, projectId);
      await subject.save(payload);
    }

    // A topic is finished when its answers are in the brief, OR when the client answered it and we
    // could not parse what they said. The second case is what stops the conversation looping: the
    // agenda is derived from the payload, so without it an unparsable reply leaves the topic
    // permanently unanswered and the next question is the same question.
    const remaining = TOPICS.filter(
      (topic) => !topic.answered(payload) && !payload.unparsedReplies?.[topic.id]?.trim(),
    );
    const answeredCount = TOPICS.length - remaining.length;

    if (!remaining.length) {
      return {
        done: true,
        topicId: null,
        message: this.closingMessage(payload),
        payload,
        answeredCount,
        totalCount: TOPICS.length,
      };
    }

    const next = remaining[0];
    return {
      done: false,
      topicId: next.id,
      message: await this.phrase(next, payload, Boolean(reply), projectId),
      payload,
      answeredCount,
      totalCount: TOPICS.length,
    };
  }

  /**
   * Pulls this topic's fields out of a free-text reply.
   *
   * Scoped to the topic on purpose. Re-deriving the whole payload from every reply would let an
   * answer about launch dates quietly rewrite the feature list, and a client who has already
   * corrected something would watch it change back.
   */
  private async absorb(
    payload: ClientIntakePayload,
    topic: (typeof TOPICS)[number],
    reply: string,
    projectId?: string,
  ): Promise<ClientIntakePayload> {
    let extracted: Record<string, unknown> = {};
    try {
      const result = await this.llm.generateJson<Record<string, unknown>>({
        agentName: 'intake-interview',
        subagent: 'requirements-parser',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `The client was asked: "${topic.opening}"

They replied:
"""
${reply}
"""

Return ONLY a JSON object with these keys: { ${topic.fields} }

Extract only what they actually said. Omit anything they did not mention — do not fill a key with a
plausible guess. Keep their wording.`,
        expectedShape: 'object',
        correlation: projectId ? { projectId } : undefined,
      });
      extracted = result.value ?? {};
    } catch (error) {
      // The client said something real. Discarding it because a provider was unavailable is the
      // one outcome worth avoiding entirely, so it is kept verbatim against the topic it answered
      // and the agenda treats the topic as covered — otherwise the same question is asked again on
      // the next turn, forever. A project manager reads their words instead of a blank section.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Interview extraction failed on ${topic.id} for ${projectId ?? 'a new lead'}: ${message}`);
      const next: ClientIntakePayload = {
        ...payload,
        unparsedReplies: { ...payload.unparsedReplies, [topic.id]: reply },
      };
      // Still the best guess at the goal when nothing is recorded there yet — the opening question
      // asks precisely that, so the reply is the answer even unparsed.
      if (topic.id === 'goal' && !payload.overview.businessGoal.trim()) {
        next.overview = { ...payload.overview, businessGoal: reply };
      }
      return next;
    }

    return this.merge(payload, topic.id, extracted, reply);
  }

  private merge(
    payload: ClientIntakePayload,
    topicId: IntakeInterviewTopicId,
    extracted: Record<string, unknown>,
    reply: string,
  ): ClientIntakePayload {
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const list = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
    const rows = (value: unknown) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []);
    const next: ClientIntakePayload = { ...payload };

    // Parsing succeeded this time, so any verbatim reply held for this topic from an earlier
    // failure is superseded. Leaving it would show the project manager the same answer twice —
    // once structured, once raw — and imply the structured one was never understood.
    if (payload.unparsedReplies?.[topicId]) {
      const { [topicId]: _superseded, ...kept } = payload.unparsedReplies;
      next.unparsedReplies = kept;
    }

    if (topicId === 'goal') {
      next.overview = {
        ...payload.overview,
        // Falls back to the raw reply: they answered the question, so an extractor that returned
        // nothing is our failure, not their silence.
        businessGoal: text(extracted.businessGoal) || payload.overview.businessGoal || reply,
        successMeasures: list(extracted.successMeasures).length
          ? list(extracted.successMeasures)
          : payload.overview.successMeasures,
      };
    }

    if (topicId === 'users') {
      const roles = rows(extracted.roles).map((role) => {
        const r = role as Record<string, unknown>;
        return {
          name: text(r.name),
          responsibilities: list(r.responsibilities),
          // Never inferred. A client naming who uses the software has not described a permission
          // model, and pretending otherwise puts a guess into the locked scope.
          permissions: [] as string[],
        };
      }).filter((role) => role.name);
      if (roles.length) next.roles = roles;
    }

    if (topicId === 'musthaves') {
      const features = rows(extracted.features).map((feature) => {
        const f = feature as Record<string, unknown>;
        const priority = text(f.priority).toUpperCase();
        return {
          title: text(f.title),
          purpose: text(f.purpose),
          primaryRole: text(f.primaryRole),
          priority:
            priority === 'SHOULD_HAVE' || priority === 'NICE_TO_HAVE'
              ? (priority as 'SHOULD_HAVE' | 'NICE_TO_HAVE')
              : ('MUST_HAVE' as const),
          workflow: '',
          businessRules: [] as string[],
          acceptanceCriteria: [] as string[],
        };
      }).filter((feature) => feature.title);
      if (features.length) next.features = features;
    }

    if (topicId === 'boundaries') {
      next.overview = {
        ...next.overview,
        targetLaunch: text(extracted.targetLaunch) || payload.overview.targetLaunch,
        approver: text(extracted.approver) || payload.overview.approver,
      };
      const integrations = rows(extracted.integrations).map((integration) => {
        const i = integration as Record<string, unknown>;
        return { name: text(i.name), purpose: text(i.purpose), owner: text(i.owner) };
      }).filter((integration) => integration.name);
      next.dataAndIntegrations = {
        ...payload.dataAndIntegrations,
        integrations: integrations.length ? integrations : payload.dataAndIntegrations.integrations,
      };
      const outOfScope = list(extracted.outOfScope);
      next.experienceAndDelivery = {
        ...payload.experienceAndDelivery,
        outOfScope: outOfScope.length ? outOfScope : payload.experienceAndDelivery.outOfScope,
      };
    }

    return next;
  }

  /**
   * Wraps the topic's fixed question in something that reads like a person.
   *
   * The question is the agenda's, not the model's — it only softens the opening and acknowledges
   * what was just said. On failure the fixed wording is used verbatim, which is plainer but never
   * wrong, and an interview that stalls because a model was unavailable would be far worse.
   */
  private async phrase(
    topic: (typeof TOPICS)[number],
    payload: ClientIntakePayload,
    afterReply: boolean,
    projectId?: string,
  ): Promise<string> {
    const fallback = `${topic.opening}\n\nFor example: ${topic.example}`;
    try {
      const result = await this.llm.generateJson<{ message?: string }>({
        agentName: 'intake-interview',
        subagent: 'requirements-parser',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `Ask the client this, in your own words: "${topic.opening}"

${afterReply ? 'They have just answered the previous topic. Acknowledge it in at most five words, then ask.' : 'This is the first question. Do not greet them at length.'}

What we already know about the project: ${payload.overview.businessGoal.trim() || '(nothing yet)'}

End with a short concrete example so they can see the shape of a useful answer. Use this one or
something closer to their project: "${topic.example}"

Return { "message": "<what you say>" }`,
        expectedShape: 'object',
        correlation: projectId ? { projectId } : undefined,
      });
      return result.value?.message?.trim() || fallback;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Interview phrasing failed on ${topic.id} for ${projectId ?? 'a new lead'}: ${message}`);
      return fallback;
    }
  }

  /**
   * The interview against a project's intake. Unchanged behaviour: this is what the client console
   * used before a lead could carry its own brief.
   */
  forProjectIntake(projectId: string, user: AuthUser): InterviewSubject {
    return {
      projectId,
      load: async () => {
        const current = await this.intake.getIntake(projectId, user);
        if (!current.intake) throw new BadRequestException(`Project ${projectId} has no intake to work on`);
        // getIntake normalises the payload on the way out, so this is the real shape despite the
        // column being untyped Json.
        return current.intake.payload as unknown as ClientIntakePayload;
      },
      save: (payload) => this.intake.saveDraft(projectId, user, payload as unknown as Record<string, unknown>).then(() => undefined),
    };
  }

  /**
   * The interview against a lead that nobody has approved yet.
   *
   * This is the one that inverts the old order. Previously a client described what they wanted only
   * after a project manager approved them and a project existed — so they waited twice before saying
   * anything substantial, and the project manager approved a scope they had not read. Filling the
   * brief in here means the client starts immediately and the approval decision is an informed one.
   *
   * Scoped to the author: the id is in the URL, so without this a client could drive the interview
   * on somebody else's lead.
   */
  /**
   * The interview against a lead nobody has approved yet.
   *
   * Takes an email rather than an `AuthUser` because the email is the entire authorization check —
   * a lead has no owning profile to compare ids against, only the address it was raised under. The
   * client BFF, which holds a session but no `AuthUser` of ours, can therefore call this honestly
   * instead of assembling a half-empty user to satisfy a signature. `AuthUser` still satisfies the
   * shape, so console call sites are unaffected.
   */
  forInquiry(inquiryId: string, client: { email: string | null }): InterviewSubject {
    const owned = async () => {
      const inquiry = await this.prisma.clientInquiry.findFirst({
        where: { id: inquiryId, email: { equals: client.email ?? '', mode: 'insensitive' } },
        select: { id: true, status: true, payload: true, companyName: true, brief: true },
      });
      if (!inquiry) throw new NotFoundException(`Request ${inquiryId} not found`);
      return inquiry;
    };

    return {
      load: async () => {
        const inquiry = await owned();
        // Seeded from what they typed when they got in touch, so the agent opens already knowing
        // roughly what this is about instead of asking them to repeat themselves.
        return (inquiry.payload as unknown as ClientIntakePayload | null)
          ?? emptyClientIntakePayload({
            projectName: inquiry.companyName,
            companyName: inquiry.companyName,
            brief: inquiry.brief,
            primaryContact: client.email,
          });
      },
      save: async (payload) => {
        const inquiry = await owned();
        // Only while it is still theirs to change. Sending it is what ends the conversation: from
        // NEW onwards a project manager is reading it, and a brief that rewrites itself under
        // somebody mid-review is worse than one that cannot be corrected.
        if (inquiry.status !== InquiryStatus.DRAFT) {
          throw new BadRequestException('This request has already been sent to your project manager.');
        }
        await this.prisma.clientInquiry.update({
          where: { id: inquiryId },
          data: { payload: payload as unknown as Prisma.InputJsonValue },
        });
      },
    };
  }

  private closingMessage(payload: ClientIntakePayload): string {
    const mustHaves = payload.features.filter((feature) => feature.priority === 'MUST_HAVE').length;
    return `That is everything I need. I have written up ${mustHaves === 1 ? 'the must-have' : `${mustHaves} must-haves`} and the rest of your answers into a brief for your project manager. Have a read on the right, change anything that looks wrong, and send it over when you are happy.`;
  }
}
