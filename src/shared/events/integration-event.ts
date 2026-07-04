import type { Prisma } from '@prisma/client';

export type ServiceBoundary =
  | 'identity'
  | 'intake'
  | 'project-delivery'
  | 'collaboration'
  | 'notifications'
  | 'orchestration'
  | 'admin';

export interface IntegrationEvent<TPayload extends Prisma.InputJsonValue = Prisma.InputJsonValue> {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  producer: ServiceBoundary;
  payload: TPayload;
  metadata?: Prisma.InputJsonValue;
}

export const IntegrationEventContracts = {
  inquirySubmitted: {
    eventType: 'intake.inquiry.submitted.v1',
    producer: 'intake',
    aggregateType: 'client_inquiry',
  },
  inquiryApproved: {
    eventType: 'intake.inquiry.approved.v1',
    producer: 'intake',
    aggregateType: 'client_inquiry',
  },
  inquiryRejected: {
    eventType: 'intake.inquiry.rejected.v1',
    producer: 'intake',
    aggregateType: 'client_inquiry',
  },
  clientInviteAccepted: {
    eventType: 'intake.client_invite.accepted.v1',
    producer: 'intake',
    aggregateType: 'client_invite',
  },
  notificationRequested: {
    eventType: 'notifications.notification.requested.v1',
    producer: 'notifications',
    aggregateType: 'notification',
  },
} as const;

export type IntegrationEventContract =
  typeof IntegrationEventContracts[keyof typeof IntegrationEventContracts];

export const IntegrationEvents = {
  inquirySubmitted: IntegrationEventContracts.inquirySubmitted.eventType,
  inquiryApproved: IntegrationEventContracts.inquiryApproved.eventType,
  inquiryRejected: IntegrationEventContracts.inquiryRejected.eventType,
  clientInviteAccepted: IntegrationEventContracts.clientInviteAccepted.eventType,
  notificationRequested: IntegrationEventContracts.notificationRequested.eventType,
} as const;

export function integrationEventContractFor(eventType: string): IntegrationEventContract | null {
  return Object.values(IntegrationEventContracts).find((contract) => (
    contract.eventType === eventType
  )) ?? null;
}
