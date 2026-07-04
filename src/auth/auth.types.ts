import { ProfileStatus, UserRole } from '@prisma/client';
import { Request } from 'express';

export interface AuthUser {
  id: string;
  email: string | null;
  fullName: string | null;
  role: UserRole;
  status?: ProfileStatus;
  authProvider?: string | null;
}

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}
