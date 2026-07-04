import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InquiryStatus, NotificationType } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { IntegrationEvents } from '../shared/events/integration-event';
import { OutboxService } from '../shared/events/outbox.service';
import {
  CursorPage,
  CursorPageInput,
  hasCursorPage,
  toCursorPage,
} from '../shared/pagination/cursor-pagination';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { ReviewInquiryDto } from './dto/review-inquiry.dto';
import { IntakeRepository, type InquiryWithReviewer } from './intake.repository';

@Injectable()
export class InquiriesService {
  constructor(
    private readonly intakeRepository: IntakeRepository,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
  ) {}

  async create(dto: CreateInquiryDto): Promise<InquiryWithReviewer> {
    const inquiry = await this.intakeRepository.transaction(async (tx) => {
      const created = await this.intakeRepository.createInquiry(tx, dto);

      await this.outbox.append(
        {
          eventType: IntegrationEvents.inquirySubmitted,
          aggregateType: 'client_inquiry',
          aggregateId: created.id,
          producer: 'intake',
          payload: {
            inquiryId: created.id,
            companyName: created.companyName,
            email: created.email,
            stackKey: created.stackKey,
          },
        },
        tx,
      );

      return created;
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(),
      type: NotificationType.INQUIRY_SUBMITTED,
      title: 'New client inquiry',
      body: `${inquiry.companyName} submitted a project brief.`,
      metadata: { inquiryId: inquiry.id, email: inquiry.email },
    });

    return inquiry;
  }

  async findAll(
    status?: InquiryStatus,
    page?: CursorPageInput,
  ): Promise<InquiryWithReviewer[] | CursorPage<InquiryWithReviewer>> {
    const inquiries = await this.intakeRepository.findInquiries(status, page);

    return hasCursorPage(page) ? toCursorPage(inquiries, page) : inquiries;
  }

  async findOne(id: string): Promise<InquiryWithReviewer> {
    const inquiry = await this.intakeRepository.findInquiry(id);

    if (!inquiry) {
      throw new NotFoundException(`Inquiry ${id} not found`);
    }

    return inquiry;
  }

  async approve(
    id: string,
    user: AuthUser,
    dto: ReviewInquiryDto,
  ): Promise<InquiryWithReviewer> {
    const inquiry = await this.findOne(id);
    if (inquiry.status !== InquiryStatus.NEW) {
      throw new BadRequestException(`Inquiry ${id} has already been reviewed`);
    }

    const note = dto.reviewNote?.trim() || null;
    const now = new Date();
    const result = await this.intakeRepository.transaction(async (tx) => {
      const approved = await this.intakeRepository.createApprovedInquiryHandoff(tx, {
        inquiry,
        actorId: user.id,
        reviewNote: note,
        reviewedAt: now,
      });

      await this.outbox.append(
        {
          eventType: IntegrationEvents.inquiryApproved,
          aggregateType: 'client_inquiry',
          aggregateId: inquiry.id,
          producer: 'intake',
          payload: {
            inquiryId: inquiry.id,
            projectId: approved.projectId,
            clientProfileId: approved.clientProfileId,
            companyName: inquiry.companyName,
          },
          metadata: { actorId: user.id },
        },
        tx,
      );

      return approved;
    });

    await this.notifications.notify({
      recipientIds: [
        ...(await this.notifications.projectManagers(result.projectId)),
        ...(result.clientProfileId ? [result.clientProfileId] : []),
      ],
      actorId: user.id,
      projectId: result.projectId,
      type: NotificationType.INQUIRY_APPROVED,
      title: 'Inquiry approved',
      body: result.inquiry.companyName,
      metadata: { inquiryId: result.inquiry.id, approvedProjectId: result.projectId },
    });

    return result.inquiry;
  }

  async reject(
    id: string,
    user: AuthUser,
    dto: ReviewInquiryDto,
  ): Promise<InquiryWithReviewer> {
    const inquiry = await this.findOne(id);
    if (inquiry.status !== InquiryStatus.NEW) {
      throw new BadRequestException(`Inquiry ${id} has already been reviewed`);
    }

    const rejected = await this.intakeRepository.transaction(async (tx) => {
      const updated = await this.intakeRepository.rejectInquiry(tx, {
        id,
        actorId: user.id,
        reviewNote: dto.reviewNote?.trim() || null,
        reviewedAt: new Date(),
      });

      await this.outbox.append(
        {
          eventType: IntegrationEvents.inquiryRejected,
          aggregateType: 'client_inquiry',
          aggregateId: updated.id,
          producer: 'intake',
          payload: {
            inquiryId: updated.id,
            companyName: updated.companyName,
          },
          metadata: { actorId: user.id },
        },
        tx,
      );

      return updated;
    });

    await this.notifications.notify({
      recipientIds: await this.notifications.projectManagers(),
      actorId: user.id,
      type: NotificationType.INQUIRY_REJECTED,
      title: 'Inquiry rejected',
      body: rejected.companyName,
      metadata: { inquiryId: rejected.id },
    });

    return rejected;
  }
}
