import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ReviewInquiryDto {
  @IsOptional()
  @IsString()
  reviewNote?: string;

  /**
   * The workspace this lead becomes work in.
   *
   * Approval creates both a client and a project. Neither carried a workspace before, which is
   * how a client could exist that the switcher could not show and a project could exist that the
   * Projects page filtered out of every workspace. Required now that Client.groupId is NOT NULL.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  groupId!: string;

  /**
   * Existing client to file this lead under, chosen by the PM from the suggested matches.
   *
   * Omitted means "resolve or create by company name". The console suggests rather than
   * auto-merges: pulling two genuinely different companies apart after a wrong silent merge is
   * far harder than linking a duplicate later.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  clientId?: string;

  /**
   * Name to create the client under, when no existing client is chosen.
   *
   * Needed because the marketing call-to-action collects only an email and a brief and sends a
   * placeholder company. Approval refuses placeholders, so the PM supplies the real name here
   * when one cannot be derived from the contact's email domain.
   */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  clientName?: string;
}
