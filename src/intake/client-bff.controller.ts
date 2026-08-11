import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { IntakeInterviewTurnDto } from './dto/intake.dto';
import { IntakeInterviewService } from './intake-interview.service';

class InquiryInterviewTurnDto extends IntakeInterviewTurnDto {
  @IsString()
  @MaxLength(200)
  inquiryId!: string;

  /**
   * The signed-in client, as authenticated by the BFF.
   *
   * Asserted rather than proven, which is the whole trust model here: the caller holds a shared
   * secret, and with it can claim to be acting for any address. That is the same authority it
   * already has through the database credentials it holds — it can read and write any lead row
   * directly — so this grants nothing new. The secret must be treated accordingly.
   */
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

/**
 * The one thing the client BFF cannot do for itself.
 *
 * `alphaexplora-client-be` owns the client's request end to end — it creates the lead, stores the
 * brief, and sends it on — all against the same database. The single exception is the model that
 * turns a sentence into structured answers, which lives here with the provider credentials and the
 * cost accounting.
 *
 * So the BFF proxies exactly one call rather than growing a second copy of the interview. The
 * agenda, the prompts, and the merge rules stay in one place; had they been duplicated into the
 * public app they would have drifted, and the brief a client fills in would stop matching the one
 * a project manager reads.
 *
 * Not behind the user JWT guard: the caller is a service, not a person. Authentication is the
 * shared secret; authorization is the email the BFF asserts, which scopes the lead lookup.
 */
@Controller('internal/client-bff')
export class ClientBffController {
  constructor(private readonly interview: IntakeInterviewService) {}

  /**
   * One turn of the guided interview against an unapproved lead.
   *
   * Not idempotency-keyed, unlike its console twin. A retry here re-asks a question and re-merges
   * the same reply into the same fields — the payload is a set of answers, not a ledger — so the
   * cost of a duplicate is one model call rather than a duplicated record.
   */
  @Post('inquiry-interview')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async inquiryInterview(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: InquiryInterviewTurnDto,
  ) {
    assertClientBffAuthorized(authorization);
    return this.interview.takeTurn(
      this.interview.forInquiry(dto.inquiryId, { email: dto.email }),
      { reply: dto.reply, topicId: dto.topicId },
    );
  }
}

/**
 * Verifies the shared secret presented by the client BFF.
 *
 * Absent configuration is a refusal, not a bypass: an unset secret means this integration was
 * never turned on for this deployment, and the failure mode of the alternative is an open route.
 */
export function assertClientBffAuthorized(header: string | undefined): void {
  const expected = process.env.CLIENT_BFF_SERVICE_TOKEN?.trim();
  if (!expected) {
    throw new ForbiddenException('The client BFF integration is not enabled');
  }
  const presented = (header ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!presented || presented !== expected) {
    throw new ForbiddenException('Invalid client service credentials');
  }
}
